#!/usr/bin/env node

import { main } from '../dist/cli-node.js';

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
