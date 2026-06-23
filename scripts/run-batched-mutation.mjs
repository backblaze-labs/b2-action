#!/usr/bin/env node
import { isEntrypoint, main } from './run-batched-mutation-lib.mjs'

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main()
}
