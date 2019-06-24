module.exports = function setupErrorReporting() {
  const disableRavenLogging = process.env.DISABLE_RAVEN_LOG;

  let Raven = {
    isStub: true,
    captureException:
      // eslint-disable-next-line no-console
      console.log /* stub it out with console.log so that errors are not swallowed */,
  };

  if (!disableRavenLogging) {
    // eslint-disable-next-line global-require
    Raven = require('raven');
    // Setup error logging
    Raven.config('', {
      autoBreadcrumbs: {
        http: true,
      },
    }).install();
  }

  return Raven;
};
