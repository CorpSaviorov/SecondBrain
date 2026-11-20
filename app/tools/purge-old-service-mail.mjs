// One-off cleanup requested by the owner on 2026-11-19: permanently remove SERVICE e-mail (ads, notifications,
// receipts, codes, spam — anything with a row in mail_categories) dated before a cutoff from SecondBrain.
// Real correspondence (no mail_categories row) and records with the owner's notes/pins are never touched.
// The mailboxes themselves are not touched. Run with the server STOPPED. Default is a dry run; pass --apply to delete.
// Usage: node tools/purge-old-service-mail.mjs <brain.sqlite> <YYYY-MM-DD cutoff, Moscow midnight> [--apply]
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const [file,day,flag]=process.argv.slice(2);
if(!file||!/^\d{4}-\d{2}-\d{2}$/.test(day||''))throw Error('usage: node tools/purge-old-service-mail.mjs <brain.sqlite> <YYYY-MM-DD> [--apply]');
const cutoff=new Date(day+'T00:00:00+03:00').toISOString(),apply=flag==='--apply';
const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;');
db.exec('CREATE TEMP TABLE del(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS temp.no_notes(source_id TEXT)');
const notes=db.prepare("SELECT 1 FROM sqlite_master WHERE name='record_annotations'").get()?'record_annotations':'temp.no_notes';
db.prepare(`INSERT INTO del SELECT s.id FROM sources s JOIN mail_categories m ON m.source_id=s.id
 WHERE s.provider='email' AND s.source_date<? AND s.id NOT IN (SELECT source_id FROM ${notes})`).run(cutoff);
const n=db.prepare('SELECT count(*) n FROM del').get().n,cards=db.prepare('SELECT count(DISTINCT source_id) n FROM cards WHERE source_id IN (SELECT id FROM del)').get().n;
const kept=db.prepare(`SELECT count(*) n FROM sources s LEFT JOIN mail_categories m ON m.source_id=s.id WHERE s.provider='email' AND s.source_date<? AND m.source_id IS NULL`).get(cutoff).n;
console.log(JSON.stringify({cutoff,service_to_delete:n,with_cards:cards,old_correspondence_kept:kept,apply}));
if(!apply){db.close();process.exit(0);}
const bySource=['versions','aliases','capture_receipts','terms','cards','card_evidence','card_terms','assessments','links','pending_captures','pending_capture_resolutions','project_assignments','processing_queue','processing_snapshots','mail_locations','mail_categories','mail_signals','asset_text','asset_terms','legacy_cards_archive','card_queue_migration','record_annotation_history'];
const exists=t=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t));
db.exec('BEGIN IMMEDIATE');const removed={};let files=[];
try{
 // Raw messages and attachment files that only these records use.
 db.exec(`CREATE TEMP TABLE dead_raw AS SELECT DISTINCT raw_hash h FROM capture_receipts WHERE source_id IN (SELECT id FROM del)
  AND raw_hash NOT IN (SELECT raw_hash FROM capture_receipts WHERE source_id NOT IN (SELECT id FROM del))
  AND raw_hash NOT IN (SELECT raw_hash FROM pending_captures WHERE source_id NOT IN (SELECT id FROM del))`);
 files=db.prepare(`SELECT DISTINCT path FROM assets WHERE source_id IN (SELECT id FROM del) AND path IS NOT NULL
  AND path NOT IN (SELECT path FROM assets WHERE path IS NOT NULL AND (source_id IS NULL OR source_id NOT IN (SELECT id FROM del)))`).all().map(r=>r.path);
 if(exists('processing_drafts')&&exists('processing_attempts'))db.exec(`DELETE FROM processing_drafts WHERE attempt_id IN (SELECT id FROM processing_attempts WHERE source_id IN (SELECT id FROM del))`);
 if(exists('processing_attempts'))removed.processing_attempts=Number(db.prepare('DELETE FROM processing_attempts WHERE source_id IN (SELECT id FROM del)').run().changes);
 for(const t of bySource)if(exists(t))removed[t]=Number(db.prepare(`DELETE FROM ${t} WHERE source_id IN (SELECT id FROM del)`).run().changes);
 removed.links_in=Number(db.prepare('DELETE FROM links WHERE target IN (SELECT id FROM del)').run().changes);
 removed.assets=Number(db.prepare('DELETE FROM assets WHERE source_id IN (SELECT id FROM del)').run().changes);
 removed.source_fts=Number(db.prepare('DELETE FROM source_fts WHERE source_id IN (SELECT id FROM del)').run().changes);
 removed.raw_captures=Number(db.prepare('DELETE FROM raw_captures WHERE hash IN (SELECT h FROM dead_raw)').run().changes);
 removed.sources=Number(db.prepare('DELETE FROM sources WHERE id IN (SELECT id FROM del)').run().changes);
 if(removed.sources!==n)throw Error('source count mismatch '+removed.sources+' != '+n);
 db.exec('COMMIT');
}catch(e){db.exec('ROLLBACK');throw e;}
// Attachment files are content-addressed under store/assets; delete only those inside that folder.
const root=path.resolve(path.dirname(file),'assets');let deletedFiles=0,freed=0;
for(const p of files){const full=path.resolve(p);if(!full.startsWith(root+path.sep))continue;try{freed+=fs.statSync(full).size;fs.unlinkSync(full);deletedFiles++;}catch{}}
console.log(JSON.stringify({removed,attachment_files:deletedFiles,attachment_bytes:freed}));
db.close();
