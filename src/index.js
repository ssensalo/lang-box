import { ApiClient } from "./api.js";
import { createContent } from "./text.js";
import { runLinguist } from "./linguist.js";

const { GH_TOKEN, GIST_ID, USERNAME, DAYS } = process.env;

(async () => {
  try {
    if (!GH_TOKEN) {
      throw new Error("GH_TOKEN is not provided.");
    }
    if (!GIST_ID) {
      throw new Error("GIST_ID is not provided.");
    }
    if (!USERNAME) {
      throw new Error("USERNAME is not provided.");
    }

    const api = new ApiClient(GH_TOKEN);
    const username = USERNAME;
    const days = Math.max(1, Math.min(30, Number(DAYS || 14)));

    console.log(`username is ${username}.`);
    console.log(`\n`);

    // https://docs.github.com/en/rest/reference/activity
    // GitHub API supports 300 events at max and events older than 90 days will not be fetched.
    const maxEvents = 300;
    const perPage = 100;
    const pages = Math.ceil(maxEvents / perPage);
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const commits = [];
    const seenCommits = new Set();
    
    const isZeroSha = (sha) => !sha || /^0+$/.test(sha);
    
    for (let page = 1; page <= pages; page++) {
      try {
        const events = await api.fetch(
          `/users/${username}/events?per_page=${perPage}&page=${page}`
        );
    
        const pushEvents = events.filter(
          ({ type, actor }) =>
            type === "PushEvent" &&
            actor.login === username
        );
    
        const recentPushEvents = pushEvents.filter(
          ({ created_at }) => new Date(created_at) > fromDate
        );
    
        console.log(`${recentPushEvents.length} events fetched.`);
    
        for (const { repo, payload } of recentPushEvents) {
          const { before, head } = payload ?? {};
    
          // Ignore branch/tag deletion events
          if (isZeroSha(head)) {
            continue;
          }
    
          let commitShas = [head];
    
          /*
           * Current PushEvent payloads no longer provide payload.commits.
           * Use before/head to retrieve the commits contained in the push.
           */
          if (!isZeroSha(before) && before !== head) {
            try {
              const comparison = await api.fetch(
                `/repos/${repo.name}/compare/${before}...${head}`
              );
    
              commitShas = (comparison.commits ?? []).map(
                (commit) => commit.sha
              );
            } catch (e) {
              console.warn(
                `Could not compare ${repo.name} ${before}...${head}:`,
                e.message
              );
    
              // Fall back to at least processing the head commit.
              commitShas = [head];
            }
          }
    
          for (const sha of commitShas) {
            const key = `${repo.name}:${sha}`;
    
            if (seenCommits.has(key)) {
              continue;
            }
    
            seenCommits.add(key);
    
            try {
              const commit = await api.fetch(
                `/repos/${repo.name}/commits/${sha}`
              );
    
              commits.push(commit);
            } catch (e) {
              console.warn(
                `Could not fetch commit ${repo.name}@${sha}:`,
                e.message
              );
            }
          }
        }
    
        const isEnd =
          pushEvents.length === 0 ||
          recentPushEvents.length < pushEvents.length;
    
        if (isEnd) {
          break;
        }
      } catch (e) {
        console.error(
          `Failed fetching GitHub events page ${page}:`,
          e
        );
        throw e;
      }
    }
    
    console.log(`${commits.length} commits fetched.`);
    console.log(`\n`);

    // https://docs.github.com/en/rest/reference/repos#compare-two-commits
    const files = commits
      // Ignore merge commits
      .filter((c) => c.parents.length <= 1)
      .flatMap((c) =>
        c.files.map(
          ({
            filename,
            additions,
            deletions,
            changes,
            status, // added, removed, modified, renamed
            patch,
          }) => ({
            path: filename,
            additions,
            deletions,
            changes,
            status,
            patch,
          })
        )
      );

    const langs = await runLinguist(files);
    console.log(`\n`);
    langs.forEach((l) =>
      console.log(
        `${l.name}: ${l.count} files, ${l.additions + l.deletions} changes`
      )
    );

    const content = createContent(langs);
    console.log(`\n`);
    console.log(content);
    console.log(`\n`);

    const gist = await api.fetch(`/gists/${GIST_ID}`);
    const filename = Object.keys(gist.files)[0];
    await api.fetch(`/gists/${GIST_ID}`, "PATCH", {
      files: {
        [filename]: {
          filename: `💻 Recent coding in languages`,
          content,
        },
      },
    });

    console.log(`Update succeeded.`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
