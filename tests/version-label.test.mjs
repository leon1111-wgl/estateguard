import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// The sidebar shows the release version. It must follow package.json and the newest CHANGELOG entry, so it cannot
// fall behind again (0.4.0 shipped with the sidebar still reading v0.3).
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const version=JSON.parse(read('../package.json')).version;
test('the sidebar note shows the package version',()=>{
 const shown=read('../web/index.html').match(/<p class="sidebar-note">[^<]*· v(\d+\.\d+\.\d+)<br>/);
 assert.ok(shown,'sidebar note with a version');assert.equal(shown[1],version);
});
test('the newest CHANGELOG entry is the package version',()=>{
 const newest=read('../CHANGELOG.md').match(/^## (\d+\.\d+\.\d+) · /m);
 assert.ok(newest,'a versioned CHANGELOG entry');assert.equal(newest[1],version);
});
