#!/usr/bin/env node
/**
 * CLI wrapper for the managed lychee runner. Keep the implementation in
 * run-lychee-lib.mjs so tests can import it without loading an executable
 * shebang file through Vitest on Windows.
 */
import { isEntrypoint, main } from './run-lychee-lib.mjs'

if (isEntrypoint(import.meta.url, process.argv[1])) {
  await main()
}
