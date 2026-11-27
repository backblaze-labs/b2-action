// Preloaded (`node --import`) into each standalone simulator the tests start.
// The test worker holds the write end of the simulator's stdin; when the worker
// exits for any reason, SIGKILL included, that pipe closes and the simulator
// exits too, so no server outlives its test file.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
process.stdin.resume()
