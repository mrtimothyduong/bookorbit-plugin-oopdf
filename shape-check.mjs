/**
 * Runs the real BookOrbit plugin-shape gates against index.mjs, copied verbatim from
 * server/src/modules/book-request/indexers/plugins/plugin-shape.ts, so a plugin that would be
 * refused on boot is caught here before it ships. Exits non-zero on any rejection.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
import plugin from './index.mjs';

const BOOK_REQUEST_MEDIA_KINDS = ['ebook', 'audiobook', 'comic'];
const PLUGIN_API_VERSION = 1;

const TYPE_SLUG = /^[a-z0-9][a-z0-9-]{0,29}$/;
const isPluginTypeSlug = (v) => TYPE_SLUG.test(v);

function isPluginVersion(version) {
  return (
    version.length <= 64 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)
  );
}

function assertField(field) {
  if (typeof field?.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(field.key))
    throw new Error('a settings field has no usable key');
  if (!['boolean', 'string', 'number'].includes(field.type))
    throw new Error(`settings field "${field.key}" has an unknown type`);
  if (typeof field.label !== 'string' || field.label.trim() === '')
    throw new Error(`settings field "${field.key}" has no label`);
  if (field.format !== undefined && field.format !== 'list')
    throw new Error(`settings field "${field.key}" has an unknown format`);
  if (field.format === 'list' && field.type !== 'string')
    throw new Error(`settings field "${field.key}" can only use list format with a string value`);
  if (field.options !== undefined) assertFieldOptions(field);
  if (field.minItems !== undefined) assertFieldMinimum(field);
}

function assertFieldOptions(field) {
  if (field.format !== 'list' || !Array.isArray(field.options) || field.options.length === 0)
    throw new Error(`settings field "${field.key}" can only declare options for a non-empty list`);
  const normalized = new Set();
  for (const option of field.options) {
    if (typeof option !== 'string' || option.trim() === '' || option.length > 40)
      throw new Error(`settings field "${field.key}" has an unusable option`);
    const canonical = option.trim().toLowerCase();
    if (normalized.has(canonical)) throw new Error(`settings field "${field.key}" has duplicate options`);
    normalized.add(canonical);
  }
  if (field.default !== undefined) {
    if (typeof field.default !== 'string') throw new Error(`settings field "${field.key}" has a non-string default`);
    const defaults = parseList(field.default);
    if (defaults.some((entry) => !normalized.has(entry.toLowerCase())))
      throw new Error(`settings field "${field.key}" has a default outside its options`);
  }
}

function assertFieldMinimum(field) {
  const minItems = field.minItems;
  if (minItems === undefined || !Number.isInteger(minItems) || minItems < 0 || !field.options || minItems > field.options.length)
    throw new Error(`settings field "${field.key}" has an unusable minimum item count`);
  if (minItems > 0) {
    if (typeof field.default !== 'string' || parseList(field.default).length < minItems)
      throw new Error(`settings field "${field.key}" needs a default that meets its minimum item count`);
  }
}

function parseList(value) {
  const entries = new Map();
  for (const entry of value.split(',').map((i) => i.trim()).filter(Boolean)) entries.set(entry.toLowerCase(), entry);
  return [...entries.values()];
}

function assertUpdateChannel(value) {
  const update = value ?? {};
  const manifest = new URL(update.manifestUrl ?? '');
  if (manifest.protocol !== 'https:') throw new Error('its update manifest URL must use https');
  if (typeof update.ed25519PublicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(update.ed25519PublicKey))
    throw new Error('its update public key must be a base64url-encoded Ed25519 key');
}

const has = (fn) => typeof plugin[fn] === 'function';

function assertPluginShape(p) {
  if (p.apiVersion !== PLUGIN_API_VERSION)
    throw new Error(`it targets plugin API version ${String(p.apiVersion)}, and this build speaks version ${PLUGIN_API_VERSION}`);
  if (typeof p.type !== 'string' || !isPluginTypeSlug(p.type)) throw new Error('its type must be a lowercase slug of at most 30 characters');
  if (p.version !== undefined && (typeof p.version !== 'string' || !isPluginVersion(p.version)))
    throw new Error('its version must be a semantic version such as 1.2.3, without a leading "v"');
  if (p.update !== undefined) assertUpdateChannel(p.update);
  if (typeof p.label !== 'string' || p.label.trim() === '') throw new Error('it declares no label');
  if (!has('search')) throw new Error('it exports no search function');
  if (!has('test')) throw new Error('it exports no test function');
  if (typeof p.requiresCredential !== 'boolean') throw new Error('it does not say whether it requires a credential');
  if (typeof p.usesCategories !== 'boolean') throw new Error('it does not say whether it uses categories');
  if (typeof p.seedsBack !== 'boolean') throw new Error('it does not say whether it seeds back');
  if (!Array.isArray(p.mediaKinds) || p.mediaKinds.length === 0) throw new Error('it declares no media kinds');
  for (const kind of p.mediaKinds) if (!BOOK_REQUEST_MEDIA_KINDS.includes(kind)) throw new Error(`"${String(kind)}" is not a media kind`);
  if (has('fetchTorrentFile') && has('resolveFile'))
    throw new Error('it declares both fetchTorrentFile and resolveFile, and a release can only be one of those');
  if (!has('fetchTorrentFile') && !has('resolveFile'))
    throw new Error('it declares neither fetchTorrentFile nor resolveFile, so nothing it finds could be grabbed');
  for (const field of p.settingsFields ?? []) assertField(field);
}

let pass = 0;
let fail = 0;
const ok = (name, condition, extra) => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`, extra ?? ''); }
};

console.log('loader gates (assertPluginShape, copied verbatim)');
try {
  assertPluginShape(plugin);
  ok('passes assertPluginShape on boot', true);
} catch (error) {
  ok('passes assertPluginShape on boot', false, error.message);
}
ok('type is a directory-safe slug', isPluginTypeSlug(plugin.type), plugin.type);
ok('exactly one grab path (resolveFile)', has('resolveFile') && !has('fetchTorrentFile'));
ok('declares no update channel (unsigned)', plugin.update === undefined);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
