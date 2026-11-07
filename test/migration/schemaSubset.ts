// Minimal JSON Schema 2020-12 validator for test/migration/schema/ only.
// It implements exactly the keywords those schemas use and THROWS on any other
// keyword, so a schema can never pass here by using something it ignores.
// Not a general validator; the Rust consumer (D3.2) should use a full one.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Schema = Record<string, unknown> | boolean;
const KNOWN = new Set(['$schema', '$id', '$comment', 'title', 'description', '$defs', 'x-dfv-version', 'type', 'const', 'enum',
  'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'pattern', 'minLength',
  'maxLength', 'minimum', 'maximum', 'oneOf', 'anyOf', '$ref']);

export class SchemaSet {
  readonly documents = new Map<string, Record<string, unknown>>();
  constructor(readonly dir: string) {
    for (const name of readdirSync(dir).filter(f => f.endsWith('.schema.json')).sort()) {
      this.documents.set(name, JSON.parse(readFileSync(join(dir, name), 'utf8')));
    }
  }

  /** Every $ref in every document, resolved; throws on any dangling or external ref. */
  checkClosed(): string[] {
    const refs: string[] = [];
    const visit = (node: unknown, doc: string) => {
      if (Array.isArray(node)) { node.forEach(n => visit(n, doc)); return; }
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (!KNOWN.has(key)) throw new Error(`${doc}: unsupported keyword "${key}"`);
        if (key === '$ref') { this.resolve(String(value), doc); refs.push(`${doc} -> ${value}`); }
        else if (key === 'properties' || key === '$defs') for (const sub of Object.values(value as object)) visit(sub, doc);
        else visit(value, doc);
      }
    };
    for (const [name, doc] of this.documents) visit(doc, name);
    return refs;
  }

  resolve(ref: string, from: string): { schema: Schema; doc: string } {
    const [file, pointer = ''] = ref.split('#');
    const doc = file || from;
    if (/^[a-z]+:/i.test(file) || file.includes('/')) throw new Error(`${from}: external $ref "${ref}"`);
    let node: unknown = this.documents.get(doc);
    if (node === undefined) throw new Error(`${from}: $ref to missing document "${doc}"`);
    for (const part of pointer.split('/').filter(Boolean)) {
      node = (node as Record<string, unknown>)[part];
      if (node === undefined) throw new Error(`${from}: dangling $ref "${ref}"`);
    }
    return { schema: node as Schema, doc };
  }

  validate(value: unknown, docName: string, pointer = ''): string[] {
    const { schema, doc } = this.resolve(`${docName}#${pointer}`, docName);
    const errors: string[] = [];
    this.check(value, schema, doc, '$', errors);
    return errors;
  }

  private check(value: unknown, schema: Schema, doc: string, path: string, errors: string[]): void {
    if (schema === true) return;
    if (schema === false) { errors.push(`${path}: not allowed`); return; }
    for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`${doc}: unsupported keyword "${key}"`);
    const s = schema as Record<string, any>;
    if (s.$ref) { const target = this.resolve(s.$ref, doc); this.check(value, target.schema, target.doc, path, errors); }
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (s.type) {
      const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
      const ok = types.some(t => t === kind || (t === 'integer' && typeof value === 'number' && Number.isInteger(value)) || (t === 'number' && typeof value === 'number'));
      if (!ok) { errors.push(`${path}: expected ${types.join('|')}`); return; }
    }
    if ('const' in s && JSON.stringify(value) !== JSON.stringify(s.const)) errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: not in enum`);
    if (typeof value === 'string') {
      if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${path}: does not match ${s.pattern}`);
      if (s.minLength !== undefined && [...value].length < s.minLength) errors.push(`${path}: too short`);
      if (s.maxLength !== undefined && [...value].length > s.maxLength) errors.push(`${path}: too long`);
    }
    if (typeof value === 'number') {
      if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below minimum`);
      if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: above maximum`);
    }
    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: too few items`);
      if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: too many items`);
      const prefix: Schema[] = s.prefixItems ?? [];
      value.forEach((item, i) => {
        if (i < prefix.length) this.check(item, prefix[i], doc, `${path}[${i}]`, errors);
        else if (s.items !== undefined) this.check(item, s.items, doc, `${path}[${i}]`, errors);
      });
    }
    if (kind === 'object') {
      const object = value as Record<string, unknown>;
      for (const key of s.required ?? []) if (!(key in object)) errors.push(`${path}.${key}: required`);
      for (const [key, item] of Object.entries(object)) {
        if (s.properties && key in s.properties) this.check(item, s.properties[key], doc, `${path}.${key}`, errors);
        else if (s.additionalProperties !== undefined) this.check(item, s.additionalProperties, doc, `${path}.${key}`, errors);
      }
    }
    for (const [keyword, need] of [['oneOf', 1], ['anyOf', 0]] as const) {
      if (!s[keyword]) continue;
      const passing = (s[keyword] as Schema[]).filter(branch => { const e: string[] = []; this.check(value, branch, doc, path, e); return e.length === 0; }).length;
      if (keyword === 'oneOf' ? passing !== need : passing === 0) errors.push(`${path}: ${keyword} matched ${passing} branches`);
    }
  }
}
