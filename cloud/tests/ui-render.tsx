import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ImporterView} from '../app/status-view';
const inactive={key_configured:false,writes_enabled:false,migration_verified:false,connection_verified_at:null,recovery_required:false};
const render=(status:typeof inactive|null=inactive,error='')=>renderToStaticMarkup(<ImporterView status={status} error={error} loading={false} refresh={()=>{}}/>);
const markup=render();
for(const value of ['Parcel Gmail Importer','https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/af/7d/f1/af7df164-b182-a0db-19ca-d30f48ab72e4/AppIcon-0-0-1x_U007epad-0-0-0-1-0-0-85-220.png/512x512bb.jpg','Importing paused','Parcel API key','Parcel connection','Existing import history','Cloud importing','Needed','Not verified','Pending'])assert.ok(markup.includes(value),value);
for(const value of ['Three careful steps','from your inbox','YOUR PRIVATE IMPORTER','BEFORE THE SWITCH','last hour','last 24 hours'])assert.ok(!markup.includes(value),value);
assert.equal((markup.match(/<li>/g)||[]).length,4);
const active=render({...inactive,key_configured:true,writes_enabled:true,migration_verified:true});assert.ok(active.includes('Importing enabled'));assert.ok(!active.includes('Secure API key entry'));
const unavailable=render(null,'Status is temporarily unavailable.');assert.ok(unavailable.includes('role="alert"'));assert.ok(!unavailable.includes('<ol'));
const signedOut=render(null,'Sign in to view your importer.');assert.ok(signedOut.includes('/signin-with-chatgpt?return_to=%2F'));assert.ok(!render(null,'This importer is private to its owner.').includes('Sign in with ChatGPT'));
console.log('UI render tests passed: title, official icon reference, 4 setup rows, key-missing/active/error/signed-out states, and removed filler.');

assert.ok(markup.includes('Made by John Niedermeyer, with a little help from Codex.'));
assert.ok(markup.includes('href="https://github.com/niederme/parcel-gmail-importer/issues"'));
assert.ok(markup.includes('href="https://nieder.me/"'));
assert.ok(markup.includes('aria-label="Project links"'));
assert.ok(!markup.includes('AIQuota'));
console.log('Footer attribution, verified links, and reference adaptation passed.');

const css=readFileSync('app/globals.css','utf8');
const footerRule=css.match(/\.app-footer\{([^}]+)\}/)?.[1]??'';
for(const rule of ['border:0','border-radius:0','background:none','box-shadow:none'])assert.ok(footerRule.includes(rule),rule);
console.log('Footer has no border, background, rounding, or shadow.');
