#!/usr/bin/env node
// Stamps version.json before the Vite builds run. See scripts/app-version.mjs.

import { writeAppVersion } from './app-version.mjs';

const info = writeAppVersion();
console.log(`[version] ${info.buildId} (built ${info.builtAt})`);
