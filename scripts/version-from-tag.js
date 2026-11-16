#!/usr/bin/env node
'use strict';
// Turns the GitHub ref of a run into the program version.
//   refs/tags/v1.2.0  -> 1.2.0
//   refs/heads/<any>  -> 0.0.0-manual.<run number>   (manual run, no Release)
// Anything else is refused, so tag text can never reach a shell or a file name.

const TAG = /^(?:refs\/tags\/)?v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const BRANCH = /^refs\/heads\/\S{1,150}$/;
const RUN = /^[0-9]{1,10}$/;

function versionFromRef(ref, runNumber) {
  if (typeof ref !== 'string' || ref.length > 200) throw new Error('not a release version tag');
  const m = TAG.exec(ref);
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  if (BRANCH.test(ref)) {
    if (typeof runNumber !== 'string' || !RUN.test(runNumber)) throw new Error('bad run number for a manual run');
    return `0.0.0-manual.${parseInt(runNumber, 10)}`;
  }
  throw new Error('not a release version tag');
}

module.exports = { versionFromRef };

if (require.main === module) {
  try {
    process.stdout.write(versionFromRef(process.argv[2], process.argv[3]) + '\n');
  } catch (e) {
    const shown = JSON.stringify(String(process.argv[2]).slice(0, 60));
    process.stderr.write(`${shown} is not a release version tag (expected vMAJOR.MINOR.PATCH, for example v1.2.0): ${e.message}\n`);
    process.exit(1);
  }
}
