// The scheduling engine of the learning app, ported from learn/ (Python, the
// reference). Plain ES modules, no dependencies, no I/O: every function works
// on data passed in, so it runs the same in a browser and in Node.
//
//   import * as engine from './engine/index.js';
//   const data = engine.subject.subjectData({ slug, subjectJson, inventoryJson, log });
//   const { slots, meta } = engine.schedule.plan({
//     items: data.scheduled, state: data.state, kind: 'review',
//     day: engine.time.today(), now: engine.time.nowEpoch(),
//     group: (u) => data.subject.group(u),
//   });

export * as time from './time.js';
export * as strength from './strength.js';
export * as store from './store.js';
export * as subject from './subject.js';
export * as random from './random.js';
export * as schedule from './schedule.js';
export * as choose from './choose.js';
export * as summary from './summary.js';
export * as sha1 from './sha1.js';
export * as questions from './questions.js';
export * as ahead from './ahead.js';
export * as brief from './brief.js';
export * as stats from './stats.js';
export * as session from './session.js';
export * as util from './util.js';
