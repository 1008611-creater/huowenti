import fs from 'node:fs';
import path from 'node:path';

const root = 'E:/codex/hekesong2';
const outDir = path.join(root, 'assets', 'fonts');
fs.mkdirSync(outDir, {recursive:true});
const log = (m)=>{ fs.appendFileSync(path.join(root,'logs','fetch-fonts.log'), new Date().toISOString()+' '+m+'\n'); };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const fams = [
  {family:'Noto Serif SC', weights:[500,600,700]},
  {family:'DM Mono', weights:[400,500]}
];

let css = '';
for (const f of fams) {
  const url = 'https://fonts.googleapis.com/css2?family=' + f.family.replace(/ /g,'+') + ':wght@' + f.weights.join(';') + '&display=swap';
  const res = await fetch(url, {headers:{'User-Agent':UA}});
  const text = await res.text();
  log('css ' + f.family + ' status=' + res.status + ' len=' + text.length);
  css += '\n/* ' + f.family + ' */\n' + text;
}

const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m=>m[1]))];
log('unique font files: ' + urls.length);

const map = new Map();
let done = 0, bytes = 0;
const CONC = 10;
async function worker(list, id) {
  for (let i = id; i < list.length; i += CONC) {
    const u = list[i];
    const name = u.split('/').pop().split('?')[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(u, {headers:{'User-Agent':UA}});
        if (!r.ok) throw new Error('status ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        fs.writeFileSync(path.join(outDir, name), buf);
        map.set(u, name);
        bytes += buf.length; done++;
        break;
      } catch (e) {
        if (attempt === 2) log('FAIL ' + u + ' ' + e.message);
        else await new Promise(r=>setTimeout(r, 800));
      }
    }
  }
}
await Promise.all(Array.from({length:CONC}, (_,i)=>worker(urls, i)));
log('downloaded ' + done + '/' + urls.length + ' totalBytes=' + bytes + ' (' + (bytes/1048576).toFixed(2) + ' MB)');

let local = css;
for (const [u, name] of map) local = local.split(u).join('./' + name);
fs.writeFileSync(path.join(outDir, 'fonts.css'), local, 'utf8');
log('wrote fonts.css len=' + local.length);
log('REMAINING_GSTATIC_REFS=' + (local.match(/fonts\.gstatic\.com/g)||[]).length);
log('DONE');
