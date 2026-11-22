'use strict';

function parseArgs(argv) {
  // argv includes node/electron binaries; find a trailing .mp4
  const file = argv.find((a) => /\.mp4$/i.test(a) && !a.startsWith('--'));
  return { file: file || null };
}

module.exports = { parseArgs };