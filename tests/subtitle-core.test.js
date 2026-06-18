const assert = require('assert');
const core = require('../src/subtitle-core.js');

const jsonCues = core.parseJson3(JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] }] }));
assert.deepStrictEqual(jsonCues, [{ start: 1, end: 3, text: 'Hello world' }]);

const vttCues = core.parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<b>Hello</b> world');
assert.deepStrictEqual(vttCues, [{ start: 1, end: 3, text: 'Hello world' }]);

global.DOMParser = class {
  parseFromString() {
    return { querySelectorAll: () => [{ getAttribute: name => name === 'start' ? '2' : '1.5', textContent: ' XML cue ' }] };
  }
};
assert.deepStrictEqual(core.parseXml('<text start="2" dur="1.5">XML cue</text>'), [{ start: 2, end: 3.5, text: 'XML cue' }]);

const cues = [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }];
assert.strictEqual(core.findCueIndex(cues, 2.5), 1);
assert.strictEqual(core.findCueIndex(cues, 3.5), -1);
assert.strictEqual(core.findStartIndex(cues, 3.5), 2);
const overlappingCues = [{ start: 10, end: 20 }, { start: 12, end: 13 }];
assert.strictEqual(core.findCueIndex(overlappingCues, 12.2), 1);
assert.strictEqual(core.limitLines('English\nVietnamese\nExtra', 2), 'Vietnamese\nExtra');
console.log('subtitle-core.test.js passed');
