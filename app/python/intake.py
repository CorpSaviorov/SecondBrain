"""Offline selected-chat intake. Python standard library only; no network or models."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


class Unsupported(ValueError):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def text_parts(parts):
    if not isinstance(parts, list):
        raise Unsupported('Expected content parts')
    text, other = [], 0
    for part in parts:
        if isinstance(part, dict) and part.get('type') in ('text', 'input_text', 'output_text') and isinstance(part.get('text'), str):
            if part.get('truncated'):
                raise Unsupported('Truncated message')
            text.append(part['text'])
        else:
            other += 1
    return '\n'.join(text), other


def message(mid, role, text, **extra):
    if not isinstance(mid, str) or not mid or role not in ('user', 'assistant') or not isinstance(text, str):
        raise Unsupported('Missing stable message identity or text')
    return dict(id=mid, role=role, text=text, **extra)


def finish(source, sid, messages, skipped, nontext, **coverage):
    unique = {}
    for msg in messages:
        old = unique.get(msg['id'])
        if old is not None and old != msg:
            raise Unsupported('Conflicting message IDs')
        unique[msg['id']] = msg
    if not unique:
        raise Unsupported('No source messages; summaries are insufficient')
    return dict(source=source, source_id=sid, messages=list(unique.values()),
                omitted=dict(skipped), nontext_references=nontext, coverage=coverage)


def app_snapshot(value):
    pages = value.get('pages') if isinstance(value, dict) and 'pages' in value else [value]
    if not isinstance(pages, list) or not pages:
        raise Unsupported('Missing pages')
    turns, identity = {}, None
    skipped, nontext = Counter(), 0
    for page in pages:
        if not isinstance(page, dict) or page.get('schemaVersion') != 1:
            raise Unsupported('Unknown app schema')
        thread, paging = page.get('thread', {}), page.get('page', {})
        key = (thread.get('kind'), thread.get('id'))
        if key[0] not in ('chatgpt', 'codex') or not key[1] or (identity and identity != key):
            raise Unsupported('Mixed or unknown threads')
        identity = key
        if paging.get('order') != 'newest_first' or not isinstance(paging.get('hasMore'), bool):
            raise Unsupported('Unknown pagination')
        for turn in page.get('turns', []):
            if not turn.get('id') or not isinstance(turn.get('startedAt'), (int, float)):
                raise Unsupported('Unknown turn schema')
            old = turns.get(turn['id'])
            if old is not None and encoded(old) != encoded(turn):
                raise Unsupported('Turn changed between overlapping pages; recapture')
            turns[turn['id']] = turn
        nontext += len(page.get('attachments') or [])
    messages = []
    for turn in sorted(turns.values(), key=lambda t: (t['startedAt'], t['id'])):
        for item in turn.get('items', []):
            kind = item.get('type')
            if kind not in ('userMessage', 'agentMessage'):
                skipped[kind or 'unknown'] += 1
                continue
            if item.get('truncated'):
                raise Unsupported('Truncated app message')
            if kind == 'userMessage':
                text, other = text_parts(item.get('content'))
                role = 'user'
            else:
                text, other, role = item.get('text'), 0, 'assistant'
            nontext += other
            messages.append(message(item.get('id'), role, text, time=None,
                                    turn_id=turn['id'], turn_started_at=turn['startedAt'],
                                    turn_completed_at=turn.get('completedAt'), phase=item.get('phase')))
    return finish(*identity, messages, skipped, nontext,
                  returned_pages_exhausted=any(p['page']['hasMore'] is False for p in pages),
                  full_conversation_export_verified=False, attachments_bytes_verified=False,
                  message_timestamps_available=False, turn_timestamps_available=True,
                  note='App read projection only; no proof of all branches, hidden Work turns, tool traces, or Library files.')


def codex_snapshot(records):
    metas = [r.get('payload', {}) for r in records if r.get('type') == 'session_meta']
    if len(metas) != 1 or not metas[0].get('id'):
        raise Unsupported('Expected one session_meta')
    if isinstance(metas[0].get('source'), dict):
        raise Unsupported('Subagent/guardian sessions excluded from user conversation intake')
    messages, skipped, nontext = [], Counter(), 0
    prefixes = ('<environment_context>', '<external_codex_apps_', '# AGENTS.md instructions for ')
    for line, record in enumerate(records, 1):
        payload = record.get('payload', {})
        if record.get('type') != 'response_item' or payload.get('type') != 'message' or payload.get('role') not in ('user', 'assistant'):
            skipped[record.get('type', 'unknown') + ':' + str(payload.get('type', ''))] += 1
            continue
        text, other = text_parts(payload.get('content'))
        if payload['role'] == 'user' and text.lstrip().startswith(prefixes):
            skipped['transport_context_as_user'] += 1
            continue
        nontext += other
        messages.append(message(payload.get('id'), payload['role'], text,
                                time=record.get('timestamp'), phase=payload.get('phase'), raw_line=line))
    return finish('codex', metas[0]['id'], messages, skipped, nontext,
                  full_conversation_export_verified=False, local_file_text_parsed=True,
                  attachments_bytes_verified=False, message_timestamps_available=True,
                  note='Selected local rollout only. Known transport wrappers excluded; raw retained. No event-only, compressed, or missing-ID adapter.')


def claude_snapshot(records, file_id):
    """Read the latest main branch; tool_result records are not human messages."""
    import uuid
    try:
        uuid.UUID(file_id)
    except (ValueError, TypeError):
        raise Unsupported('Claude filename must contain the session UUID')
    by_id = {}
    for line, record in enumerate(records, 1):
        mid = record.get('uuid')
        if not mid:
            continue
        if mid in by_id and by_id[mid][1] != record:
            raise Unsupported('Conflicting Claude record UUID')
        by_id[mid] = (line, record)
    tails = [r for r in records if r.get('type') in ('user', 'assistant')
             and r.get('uuid') and r.get('isSidechain') is False]
    if not tails:
        raise Unsupported('No recognized main Claude conversation')
    chain, seen, node = [], set(), tails[-1]['uuid']
    while node is not None:
        if node in seen or node not in by_id:
            raise Unsupported('Broken or cyclic Claude branch')
        seen.add(node)
        line, record = by_id[node]
        if record.get('isSidechain') is True:
            raise Unsupported('Main Claude branch crosses a sidechain')
        chain.append((line, record))
        node = record.get('parentUuid')
    messages, omitted, nontext = [], Counter(), 0
    for line, record in reversed(chain):
        role = record.get('type')
        if role not in ('user', 'assistant'):
            omitted[role or 'unknown_record'] += 1
            continue
        if record.get('isMeta') or record.get('isCompactSummary') or record.get('isApiErrorMessage'):
            omitted['metadata_or_compaction_or_api_error'] += 1
            continue
        content = record.get('message', {}).get('content')
        if isinstance(content, str):
            content = [dict(type='text', text=content)]
        if not isinstance(content, list):
            raise Unsupported('Unknown Claude content shape')
        texts, refs = [], 0
        for block in content:
            if not isinstance(block, dict):
                raise Unsupported('Unknown Claude content block')
            kind = block.get('type')
            if kind == 'text' and isinstance(block.get('text'), str):
                texts.append(block['text'])
            elif kind in ('tool_use', 'tool_result', 'server_tool_use', 'thinking', 'redacted_thinking'):
                omitted['block:' + kind] += 1
            else:
                refs += 1
        text = '\n'.join(texts)
        if not text and not refs:
            omitted['non_conversation_record:' + role] += 1
            continue
        if record.get('truncated'):
            raise Unsupported('Truncated Claude record')
        nontext += refs
        messages.append(message(record['uuid'], role, text, time=record.get('timestamp'),
                                phase=None, raw_line=line, parent_uuid=record.get('parentUuid')))
    omitted['records_outside_selected_chain'] = len(records) - len(chain)
    return finish('claude-code', file_id, messages, omitted, nontext,
                  full_conversation_export_verified=False, local_file_text_parsed=True,
                  attachments_bytes_verified=False, message_timestamps_available=True,
                  branch_selection='latest main-branch user/assistant UUID and its ancestors',
                  selected_leaf_uuid=tails[-1]['uuid'],
                  note='Selected main branch only. Tools, private reasoning, service errors, and compaction summaries omitted. All raw records retained.')


def read_snapshot(path, kind):
    if Path(path).stat().st_size > 256 * 1024 * 1024:
        raise Unsupported('Input too large')
    raw = Path(path).read_bytes()
    text = raw.decode('utf-8-sig')
    if kind == 'codex-jsonl':
        snapshot = codex_snapshot([json.loads(s) for s in text.split('\n') if s.strip()])
    elif kind == 'claude-code-jsonl':
        snapshot = claude_snapshot([json.loads(s) for s in text.split('\n') if s.strip()], Path(path).stem)
    elif kind == 'app-json':
        snapshot = app_snapshot(json.loads(text))
    else:
        raise Unsupported('Unknown format')
    return raw, snapshot


def immutable(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open('xb') as file:
            file.write(data)
    except FileExistsError:
        if path.read_bytes() != data:
            raise Unsupported('Archive hash/path collision')


def ingest(path, kind, archive, account='personal', mode='unspecified'):
    raw, snapshot = read_snapshot(path, kind)
    archive = Path(archive)
    cid = sha(encoded([snapshot['source'], account, snapshot['source_id']]))
    # Transport offsets and retrieval dates do not create message revisions.
    projected = [{k: m.get(k) for k in ('id', 'role', 'text', 'time', 'phase')} for m in snapshot['messages']]
    revision, raw_hash = sha(encoded(projected)), sha(raw)
    immutable(archive / 'raw' / (raw_hash + ('.jsonl' if kind.endswith('jsonl') else '.json')), raw)
    immutable(archive / 'normalized' / cid / (sha(encoded(snapshot)) + '.json'), encoded(dict(
        schema='secondbrain-selected-snapshot/v1', identity=cid, account=account, **snapshot)) + b'\n')
    database = sqlite3.connect(archive / 'index.sqlite', timeout=10)
    try:
        database.executescript('''
        CREATE TABLE IF NOT EXISTS snapshots (cid TEXT, revision TEXT, PRIMARY KEY(cid,revision));
        CREATE TABLE IF NOT EXISTS message_history (cid TEXT, mid TEXT, revision TEXT, payload TEXT, PRIMARY KEY(cid,mid,revision));
        CREATE TABLE IF NOT EXISTS message_current (cid TEXT, mid TEXT, revision TEXT, PRIMARY KEY(cid,mid));
        CREATE TABLE IF NOT EXISTS receipts (raw_hash TEXT, cid TEXT, revision TEXT, mode TEXT, PRIMARY KEY(raw_hash,cid,revision,mode));
        ''')
        with database:
            seen = database.execute('SELECT 1 FROM snapshots WHERE cid=? AND revision=?', (cid, revision)).fetchone()
            added = changed = unchanged = 0
            if not seen:
                for msg, projection in zip(snapshot['messages'], projected):
                    mrev = sha(encoded(projection))
                    old = database.execute('SELECT revision FROM message_current WHERE cid=? AND mid=?', (cid, msg['id'])).fetchone()
                    if old is None:
                        added += 1
                    elif old[0] != mrev:
                        changed += 1
                    else:
                        unchanged += 1
                    database.execute('INSERT OR IGNORE INTO message_history VALUES (?,?,?,?)', (cid, msg['id'], mrev, encoded(msg).decode()))
                    database.execute('INSERT OR REPLACE INTO message_current VALUES (?,?,?)', (cid, msg['id'], mrev))
                database.execute('INSERT INTO snapshots VALUES (?,?)', (cid, revision))
            else:
                unchanged = len(snapshot['messages'])
            database.execute('INSERT OR IGNORE INTO receipts VALUES (?,?,?,?)', (raw_hash, cid, revision, mode))
            if sha(Path(path).read_bytes()) != raw_hash:
                raise Unsupported('Source changed during import; recapture a consistent snapshot')
        return dict(identity=cid, revision=revision, raw_sha256=raw_hash,
                    source=snapshot['source'], mode=mode, messages=len(snapshot['messages']),
                    roles=dict(Counter(m['role'] for m in snapshot['messages'])),
                    new_snapshots=int(not seen), new_messages=added, changed_messages=changed,
                    unchanged_messages=unchanged, llm_calls=0, network_requests=0,
                    paid_api_calls=0, source_files_modified=0, coverage=snapshot['coverage'])
    finally:
        database.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--format', choices=['app-json', 'codex-jsonl', 'claude-code-jsonl'], required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--account', default='personal')
    parser.add_argument('--mode', default='unspecified', help='Label only; never proves Work coverage')
    args = parser.parse_args()
    try:
        result = ingest(args.input, args.format, args.archive, args.account, args.mode)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error) as error:
        print(f'Intake stopped ({type(error).__name__}); no network or model call. Inspect schema or paths.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
