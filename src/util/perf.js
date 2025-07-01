const { performance } = require('perf_hooks');

function measure(name, fn) {
  const start = performance.now();
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      const duration = performance.now() - start;
      if (global.log) {
        global.log(`Perf: ${name} took ${duration.toFixed(2)} ms`);
      } else {
        console.log(`Perf: ${name} took ${duration.toFixed(2)} ms`);
      }
    });
}

module.exports = { measure };