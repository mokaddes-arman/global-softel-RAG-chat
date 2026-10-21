'use strict';

const yaml = require('js-yaml');
const { block } = require('./util');
const { normaliseText } = require('./text');
const { flattenJson } = require('./json');

/**
 * YAML is parsed into an object (or a list of documents) and flattened into
 * readable "path: value" lines, which retrieve far better than raw indentation.
 */
function parseYaml(buffer, ctx = {}) {
  const raw = normaliseText(buffer);
  let docs;
  try {
    docs = yaml.loadAll(raw);
  } catch (err) {
    const e = new Error(`Invalid YAML in "${ctx.filename}": ${err.message}`);
    e.code = 'parse_failed';
    throw e;
  }

  const blocks = [];
  const warnings = [];
  docs.forEach((doc, idx) => {
    if (doc === undefined || doc === null) return;
    const lines = flattenJson(doc, '', []);
    const heading = docs.length > 1 ? `Document ${idx + 1}` : null;
    if (heading) blocks.push(block('heading', heading, { level: 1, location: { section: heading } }));
    const GROUP = 40;
    for (let i = 0; i < lines.length; i += GROUP) {
      const slice = lines.slice(i, i + GROUP);
      blocks.push(
        block('code', slice.join('\n'), {
          location: { section: heading || undefined, label: `keys ${i + 1}-${i + slice.length}` },
        }),
      );
    }
  });

  if (!blocks.length) warnings.push('YAML file contained no indexable content.');

  return {
    parser: 'yaml',
    blocks,
    metadata: { documents: docs.length },
    warnings,
    ocrLikely: false,
  };
}

module.exports = { parseYaml };
