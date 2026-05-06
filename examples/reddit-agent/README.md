
## Reddit semi-auto agent (Abidera)

Standalone client engagement repo. `bun add @railloom/core`. This example demonstrates: workflow with cron trigger, agent with structured output, tool with approval, corpus memory for voice exemplars, Slack approval channel, single-binary deployment.

### What it does

1. Every 30 minutes, fetch new posts from a curated list of subreddits.
2. Classify each post for relevance to Abidera using Haiku.
3. For relevant posts, draft a reply using Sonnet, retrieving similar past replies from corpus memory.
4. Post the draft to Slack with Approve / Edit / Reject buttons.
5. On approval, save the draft (the founder copies and posts to Reddit manually — Reddit API has self-promo restrictions that make full automation unwise).
6. Track outcomes (upvotes, replies) over the next 7 days, append to corpus for future voice consistency.

### Project structure

```
abidera-reddit-agent/
├── src/
│   ├── server.ts               # entry: configureRailloom + startServer + startWorker
│   ├── agents/
│   │   ├── classifier.ts
│   │   └── drafter.ts
│   ├── tools/
│   │   └── reddit.ts
│   ├── workflows/
│   │   └── monitor.ts
│   └── lib/
│       ├── reddit-auth.ts
│       └── ratio-check.ts
├── data/                       # SQLite file lives here (gitignored)
├── .env                         # secrets (gitignored)
├── package.json
└── README.md
```

### Setup (`src/server.ts`)

> **Note on provider choice.** This example uses `anthropicProvider` because the Abidera project picked Claude for its classifier and drafter. The framework itself is provider-agnostic — switching to Codex CLI for development, or to OpenAI in production via a future `openaiCompatibleProvider`, requires changing only the `provider:` line below. See § Environment-driven provider selection in CONVENTIONS.md.

```ts
import { configureRailloom, startServer, startWorker, anthropicProvider } from '@railloom/core';

import './agents/classifier';
import './agents/drafter';
import './workflows/monitor';

configureRailloom({
  dbPath: './data/abidera.db',
  provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  defaultModel: 'claude-sonnet-4-6',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    defaultApprovalChannel: '#abidera-approvals',
  },
  server: {
    port: 3000,
    publicUrl: process.env.PUBLIC_URL!,
  },
});

await startServer();
await startWorker();

// Use the framework's module-level logger (imported from @/lib/observability),
// not console.log. Consumer code follows the same convention so all lines land
// in the same structured-JSON stream readable by journalctl/Loki/Datadog.
log.info('abidera.boot', { ready: true });
```

### Tool

```ts
// src/tools/reddit.ts
import { tool } from '@railloom/core';
import { z } from 'zod';
import { getRedditToken } from '@/lib/reddit-auth';

// Validate at the trust boundary: one typed throw on schema drift, no `as any`.
const RedditListing = z.object({
  data: z.object({
    children: z.array(z.object({
      data: z.object({
        id: z.string(),
        title: z.string(),
        selftext: z.string().nullable().optional(),
        permalink: z.string(),
        author: z.string().nullable().optional(),
        created_utc: z.number(),
      }),
    })),
  }),
});

export const fetchSubredditNew = tool({
  description: 'Fetch the newest posts from a subreddit',
  input: z.object({
    subreddit: z.string(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.array(z.object({
    id: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    permalink: z.string(),
    author: z.string().nullable(),
    createdAt: z.coerce.date(),
  })),
  execute: async ({ input, ctx }) => {
    const token = await getRedditToken();
    const res = await fetch(
      `https://oauth.reddit.com/r/${input.subreddit}/new?limit=${input.limit}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'abidera-monitor/1.0 by /u/<alex>',
        },
      },
    );
    if (res.status === 401) throw new Error(`Reddit auth failed (401)`);
    if (res.status === 429) throw new Error(`Reddit rate-limited (429)`);
    if (!res.ok) throw new Error(`Reddit fetch failed: ${res.status}`);
    const json = RedditListing.parse(await res.json());
    return json.data.children.map((c) => ({
      id: c.data.id,
      title: c.data.title,
      body: c.data.selftext ?? null,
      permalink: `https://reddit.com${c.data.permalink}`,
      author: c.data.author ?? null,
      createdAt: new Date(c.data.created_utc * 1000),
    }));
  },
});
```

### Agents

```ts
// src/agents/classifier.ts
import { agent } from '@railloom/core';
import { z } from 'zod';

export const classifier = agent({
  id: 'reddit-classifier',
  model: 'claude-haiku-4-5',
  instructions: `Classify the Reddit post for relevance to Abidera, a European Portuguese audio-first iOS learning app.

Output JSON only. Be precise. Do not draft replies.

A post is "draftRecommended: true" only if all of:
- intent is one of: app-recommendation, duolingo-complaint, moving-to-portugal, ciple-exam, pronunciation-help
- fitScore >= 0.7
- the original post is asking a question or expressing a need Abidera could help with`,
  outputSchema: z.object({
    intent: z.enum([
      'app-recommendation',
      'duolingo-complaint',
      'moving-to-portugal',
      'pronunciation-help',
      'ciple-exam',
      'general-learning',
      'off-topic',
    ]),
    fitScore: z.number().min(0).max(1),
    draftRecommended: z.boolean(),
    reasoning: z.string(),
  }),
  maxSteps: 1,                       // no tools, single LLM call
});
```

```ts
// src/agents/drafter.ts
import { agent, tool, memory } from '@railloom/core';
import { z } from 'zod';
import { computeRatio } from '@/lib/ratio-check';

const searchVoiceExamples = tool({
  description: 'Find past approved replies from this subreddit, ranked by similarity to the new post',
  input: z.object({ query: z.string(), subreddit: z.string() }),
  output: z.array(z.object({ text: z.string(), similarityScore: z.number() })),
  execute: async ({ input }) => {
    const corpus = memory.corpus('voice_exemplars');
    const results = await corpus.search({
      query: input.query,
      limit: 3,
      filter: (e) => e.metadata.subreddit === input.subreddit,
    });
    return results.map((r) => ({ text: r.content, similarityScore: r.score ?? 0 }));
  },
});

const checkRatio = tool({
  description: 'Check the 9:1 self-promotion ratio for the posting account in last 30 days',
  input: z.object({}),
  output: z.object({
    okay: z.boolean(),
    abideraMentions: z.number(),
    generalComments: z.number(),
  }),
  execute: async () => {
    const r = await computeRatio('30d');
    return {
      okay: r.generalComments >= r.abideraMentions * 9,
      abideraMentions: r.abideraMentions,
      generalComments: r.generalComments,
    };
  },
});

export const drafter = agent({
  id: 'reddit-drafter',
  model: 'claude-sonnet-4-6',
  instructions: `You are drafting a Reddit reply on behalf of Alex, a solo developer in Madeira who built Abidera, an audio-first European Portuguese learning iOS app.

Hard rules:
1. Open with disclosure: "I am building Abidera, so biased, but..."
2. Answer the user's actual question first; app mention second.
3. Be specific. Name competing apps fairly (Practice Portuguese, Pimsleur, Memrise).
4. Match the subreddit's register.
5. Maximum 4 short paragraphs.
6. End with a question to invite continued conversation, not a CTA.

Before drafting, call checkRatio to ensure you are not over the 9:1 limit. Output exactly one of:
- { kind: 'draft', draftText } — when you produce a usable reply
- { kind: 'refusal', refusalReason } — when the ratio is broken or the post is not a fit`,
  tools: { searchVoiceExamples, checkRatio },
  outputSchema: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('draft'), draftText: z.string().min(1) }),
    z.object({ kind: z.literal('refusal'), refusalReason: z.string().min(1) }),
  ]),
});
```

### Workflow

```ts
// src/workflows/monitor.ts
import { workflow, suspendForApproval } from '@railloom/core';
import { z } from 'zod';
import { fetchSubredditNew } from '@/tools/reddit';
import { classifier } from '@/agents/classifier';
import { drafter } from '@/agents/drafter';

export const monitor = workflow({
  id: 'reddit-monitor',
  trigger: { cron: '*/30 * * * *' },                  // declarative; production cron generated to systemd timer
  input: z.object({}),
})
  .then({
    id: 'fetch-all-subreddits',
    execute: async ({ inputData, ctx }) => {
      const subs = ['portugalexpats', 'europeanportuguese', 'Portuguese', 'duolingo'];
      // Promise.allSettled — one subreddit failing must not kill the whole cycle.
      const settled = await Promise.allSettled(
        subs.map((s) =>
          fetchSubredditNew.execute({
            input: { subreddit: s, limit: 25 },
            ctx,
          }).then((posts) => posts.map((p) => ({ ...p, subreddit: s }))),
        ),
      );
      const successes = settled.flatMap((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        ctx.log.error('reddit.fetch.failed', { subreddit: subs[i], error: String(r.reason) });
        return [];
      });
      return successes;
    },
  })
  .foreach({
    id: 'classify-and-maybe-draft',
    execute: async ({ inputData: post, resumeData, suspend, ctx }) => {
      // First execution: classify, draft, request approval
      if (!resumeData) {
        const cls = await classifier.run({ input: post });
        if (!cls.output.draftRecommended) {
          return { postId: post.id, drafted: false };
        }

        const drf = await drafter.run({
          input: { post, classification: cls.output },
        });

        if (drf.output.kind === 'refusal') {
          return { postId: post.id, drafted: false, refusal: drf.output.refusalReason };
        }

        return await suspendForApproval(suspend, {
          kind: 'reddit_reply_draft',
          summary: `r/${post.subreddit}: ${post.title.slice(0, 80)}`,
          payload: {
            draftText: drf.output.draftText,
            postUrl: post.permalink,
            postTitle: post.title,
          },
          editable: ['draftText'],
          timeout: '24h',
        });
      }

      // Second execution (after Slack decision): act on the result
      if (resumeData.action === 'rejected' || resumeData.action === 'timed_out') {
        return { postId: post.id, drafted: true, posted: false };
      }

      const finalText = resumeData.payload!.draftText as string;
      await ctx.audit({
        action: 'reddit_draft.approved',
        resource: { kind: 'reddit_post', id: post.id },
        payload: { finalText, postUrl: post.permalink },
      });

      return { postId: post.id, drafted: true, approved: true, finalText };
    },
  }, { concurrency: 3 })
  .commit();
```

### Build and deploy

```bash
# development
bun run src/server.ts

# production binary
bun build --compile --target=bun-linux-x64 --outfile=abidera-server src/server.ts

# ship to VPS
scp abidera-server abidera-vps:/usr/local/bin/
ssh abidera-vps 'systemctl restart abidera'
```

systemd unit:

```ini
# /etc/systemd/system/abidera.service
[Unit]
Description=Abidera Reddit Agent
After=network.target

[Service]
Type=simple
User=abidera
WorkingDirectory=/var/abidera
EnvironmentFile=/var/abidera/.env
ExecStart=/usr/local/bin/abidera-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

