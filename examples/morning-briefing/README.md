
## Morning briefing agent

A different shape: cron without fan-out, multi-source `.parallel()` data fetches, single Slack post (no approval), no corpus memory.

### What it does

Every weekday at 7:00 ET, post a one-paragraph briefing to `#morning`. Combines yesterday's revenue, top traffic source, ad spend, ticket backlog. Compare against 7-day baseline. Flag deviations.

### Workflow

```ts
// src/workflows/briefing.ts
import { workflow } from '@railloom/core';
import { z } from 'zod';
import { briefer } from '@/agents/briefer';
import {
  getRevenue,
  getTopTrafficSource,
  getMetaAdSpend,
  getTicketBacklog,
} from '@/tools/metrics';
import { postToSlack } from '@/lib/slack-post';

const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const iso = d.toISOString().slice(0, 10);
  return { start: iso, end: iso };
};

export const briefing = workflow({
  id: 'morning-briefing',
  trigger: { cron: '0 7 * * 1-5' },
  input: z.object({}),
})
  .map(() => yesterday())
  .parallel([
    { id: 'revenue',  execute: async ({ inputData, ctx }) => getRevenue.execute({ input: inputData, ctx }) },
    { id: 'traffic',  execute: async ({ inputData, ctx }) => getTopTrafficSource.execute({ input: inputData, ctx }) },
    { id: 'meta-ads', execute: async ({ inputData, ctx }) => getMetaAdSpend.execute({ input: inputData, ctx }) },
    { id: 'tickets', execute: async ({ ctx }) => getTicketBacklog.execute({ input: {}, ctx }) },
  ])
  .then({
    id: 'compose',
    execute: async ({ inputData: [revenue, traffic, metaAds, tickets] }) => {
      const r = await briefer.run({ input: { revenue, traffic, metaAds, tickets } });
      return r.output;
    },
  })
  .then({
    id: 'post',
    execute: async ({ inputData, ctx }) => {
      await postToSlack({ channel: '#morning', text: inputData.briefing });
      await ctx.audit({
        action: 'briefing.posted',
        payload: { deviations: inputData.deviations },
      });
      return { ok: true };
    },
  })
  .commit();
```

This shape demonstrates: cron trigger, four `.parallel()` data fetches with tuple-typed result, single agent compose step, plain Slack post (no approval gate).

---

