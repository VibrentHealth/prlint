const flatten = require('flat');
const git = require('git-rev-sync');
const got = require('got');
const { json, send } = require('micro');
const setupErrorReporting = require('./setupErrorReporting');

const newJsonWebToken = require('./utils/newJsonWebToken.js');

const accessTokens = {};

const {
  GITHUB_URL = 'https://github.com',
  GITHUB_API_URL = 'https://api.github.com',
} = process.env;

const Raven = setupErrorReporting();

async function updateShaStatus(body, res) {
  const accessToken = accessTokens[`${body.installation.id}`].token;
  const pullRequestFlattened = flatten(body.pull_request);

  try {
    // Initialize variables
    let prlintDotJson;
    const failureMessages = [];
    const failureURLs = [];
    const headRepoFullName = body.pull_request.head.repo.full_name;
    const defaultFailureURL = `${GITHUB_URL}/${headRepoFullName}/blob/${
      body.pull_request.head.sha
    }/.github/prlint.json`;

    // Get the user's prlint.json settings (returned as base64 and decoded later)
    let prlintDotJsonUrl = `${GITHUB_API_URL}/repos/${headRepoFullName}/contents/.github/prlint.json?ref=${body
      .pull_request.merge_commit_sha || body.pull_request.head.ref}`;
    if (body.pull_request.head.repo.fork) {
      prlintDotJsonUrl = `${GITHUB_API_URL}/repos/${
        body.pull_request.base.repo.full_name
      }/contents/.github/prlint.json?ref=${body.pull_request.head.sha}`;
    }
    const prlintDotJsonMeta = await got(prlintDotJsonUrl, {
      headers: {
        Accept: 'application/vnd.github.machine-man-preview+json',
        Authorization: `token ${accessToken}`,
      },
    });

    // Convert the base64 contents to an actual JSON object
    try {
      prlintDotJson = JSON.parse(
        Buffer.from(JSON.parse(prlintDotJsonMeta.body).content, 'base64'),
      );
    } catch (e) {
      failureMessages.push(e);
    }

    // Run each of the validations (regex's)
    if (prlintDotJson) {
      Object.keys(prlintDotJson).forEach((element) => {
        if (prlintDotJson[element]) {
          prlintDotJson[element].forEach((item, index) => {
            const { pattern } = item;
            try {
              const regex = new RegExp(pattern, item.flags || '');
              const pass = regex.test(pullRequestFlattened[element]);
              if (
                !pass
                || (pullRequestFlattened[element] === null
                  || pullRequestFlattened[element] === undefined)
              ) {
                let message = `Rule \`${element}[${index}]\` failed`;
                message = item.message || message;
                failureMessages.push(message);
                const URL = item.detailsURL || defaultFailureURL;
                failureURLs.push(URL);
              }
            } catch (e) {
              failureMessages.push(e);
              failureURLs.push(defaultFailureURL);
            }
          });
        }
      });
    }

    // Build up a status for sending to the pull request
    let bodyPayload = {};
    if (!failureMessages.length) {
      bodyPayload = {
        state: 'success',
        description: 'Your validation rules passed',
        context: 'PRLint',
      };
    } else {
      let description = failureMessages[0];
      let URL = failureURLs[0];
      if (failureMessages.length > 1) {
        description = `1/${failureMessages.length - 1}: ${description}`;
        URL = defaultFailureURL;
      }
      if (description && typeof description.slice === 'function') {
        bodyPayload = {
          state: 'failure',
          description: description.slice(0, 140), // 140 characters is a GitHub limit
          target_url: URL,
          context: 'PRLint',
        };
      } else {
        bodyPayload = {
          state: 'failure',
          description:
            'Something went wrong with PRLint - You can help by opening an issue (click details)',
          target_url: 'https://github.com/VibrentHealth/prlint/issues/new',
          context: 'PRLint',
        };
      }
    }

    // POST the status to the pull request
    try {
      const statusUrl = body.pull_request.statuses_url;
      await got.post(statusUrl, {
        headers: {
          Accept: 'application/vnd.github.machine-man-preview+json',
          Authorization: `token ${accessToken}`,
        },
        body: bodyPayload,
        json: true,
      });
      send(res, 200, bodyPayload);
    } catch (exception) {
      Raven.captureException(exception, { extra: prlintDotJson });
      send(res, 500, {
        exception,
        request_body: bodyPayload,
        response: exception.response.body,
      });
    }
  } catch (exception) {
    // If anyone of the "happy path" logic above failed
    // then we post an update to the pull request that our
    // application (PRLint) had issues, or that they're missing
    // a configuration file (./.github/prlint.json)
    let statusCode = 200;
    const statusUrl = `${GITHUB_API_URL}/repos/${
      body.repository.full_name
    }/statuses/${body.pull_request.head.sha}`;
    if (exception.response && exception.response.statusCode === 404) {
      await got.post(statusUrl, {
        headers: {
          Accept: 'application/vnd.github.machine-man-preview+json',
          Authorization: `token ${accessToken}`,
        },
        body: {
          state: 'success',
          description: 'No rules are setup for PRLint',
          context: 'PRLint',
          target_url: `${GITHUB_URL}/apps/prlint`,
        },
        json: true,
      });
    } else {
      statusCode = 500;
      Raven.captureException(exception);
      await got.post(statusUrl, {
        headers: {
          Accept: 'application/vnd.github.machine-man-preview+json',
          Authorization: `token ${accessToken}`,
        },
        body: {
          state: 'error',
          description:
            'An error occurred with PRLint. Click details to open an issue',
          context: 'PRLint',
          target_url: `https://github.com/VibrentHealth/prlint/issues/new?title=Exception Report&body=${encodeURIComponent(
            exception.toString(),
          )}`,
        },
        json: true,
      });
    }
    send(res, statusCode, exception.toString());
  }
}

// Get a JWT on server start
let JWT = newJsonWebToken();

// Refresh the JSON Web Token every X milliseconds
// This saves us from persisting and managing tokens
// elsewhere (like redis or postgresql)
setInterval(() => {
  JWT = newJsonWebToken();
}, 300000 /* 5 minutes */);

// This is the main entry point, our dependency 'micro' expects a function
// that accepts standard http.IncomingMessage and http.ServerResponse objects
// https://github.com/zeit/micro#usage
module.exports = async (req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/x-icon' });
    res.end();
  }

  // Used by https://stats.uptimerobot.com/ZzYnEf2BW
  if (req.url === '/status' && req.method === 'GET') {
    res.end('OK');
  }

  // Used by developers as a sanity check
  if (req.url === '/version' && req.method === 'GET') {
    res.end(git.short());
  }

  // Used by GitHub
  if (req.url === '/webhook' && req.method === 'POST') {
    const body = await json(req);
    if (body && !body.pull_request) {
      // We just return the data that was sent to the webhook
      // since there's not really anything for us to do in this situation
      send(res, 200, body);
    } else if (body && body.action && body.action === 'closed') {
      // No point in linting anything if the pull request is closed
      send(res, 200, body);
    } else if (
      body
      && body.pull_request
      && body.installation
      && body.installation.id
      && accessTokens[`${body.installation.id}`]
      && new Date(accessTokens[`${body.installation.id}`].expires_at) > new Date() // make sure token expires in the future
    ) {
      // This is our main "happy path"
      await updateShaStatus(body, res);
    } else if (
      body
      && body.pull_request
      && body.installation
      && body.installation.id
    ) {
      // This is our secondary "happy path"
      // But we need to fetch an access token first
      // so we can read ./.github/prlint.json from their repo
      try {
        const response = await got.post(
          `${GITHUB_API_URL}/installations/${
            body.installation.id
          }/access_tokens`,
          {
            headers: {
              Accept: 'application/vnd.github.machine-man-preview+json',
              Authorization: `Bearer ${JWT}`,
            },
          },
        );
        accessTokens[`${body.installation.id}`] = JSON.parse(response.body);
        await updateShaStatus(body, res);
      } catch (exception) {
        Raven.captureException(exception);
        send(res, 500, {
          token: accessTokens[`${body.installation.id}`],
          exception,
        });
      }
    } else {
      // Doubtful GitHub will ever end up at this block
      // but it was useful while I was developing
      send(res, 400, 'invalid request payload');
    }
  } else {
    // Redirect since we don't need anyone visiting our service
    // if they happen to stumble upon our URL
    res.writeHead(301, { Location: 'https://github.com/VibrentHealth/prlint' });
    res.end();
  }
};
