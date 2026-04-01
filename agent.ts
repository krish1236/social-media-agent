/**
 * RunForge Social Content Repurposer — Full Feature Agent
 *
 * Modes:
 *   1. single_post  — URL → report → one post → approve → post
 *   2. campaign      — URL + optional context URLs → report → campaign plan → 3-5 posts → approve each
 *   3. thread        — URL → report → Twitter thread plan → 3-10 tweet thread → approve
 *   4. curate        — Scan Twitter/Reddit/GitHub → group → reports → batch posts (needs API keys)
 *   5. repurpose     — Existing content URL → fresh angles → new campaign
 *
 * All posting goes through RunForge commit_step approval → ctx.tools.twitter / ctx.tools.linkedin
 */
import { AgentRuntime, ToolsFacade } from "@runforge/sdk";
import { generatePostGraph } from "./src/agents/generate-post/generate-post-graph.js";
import { repurposerGraph } from "./src/agents/repurposer/index.js";
import { generateThreadGraph } from "./src/agents/generate-thread/index.js";
import { supervisorGraph } from "./src/agents/supervisor/supervisor-graph.js";

const runtime = new AgentRuntime();

// ── In-memory LangGraph store shim ──
type StoreItem = {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
};

class InMemoryStoreShim {
  private readonly data = new Map<string, StoreItem>();

  private toMapKey(namespace: string[], key: string): string {
    return `${namespace.join("::")}@@${key}`;
  }

  async get(namespace: string[], key: string): Promise<StoreItem | null> {
    return this.data.get(this.toMapKey(namespace, key)) ?? null;
  }

  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    this.data.set(this.toMapKey(namespace, key), { namespace, key, value });
  }

  async delete(namespace: string[], key: string): Promise<void> {
    this.data.delete(this.toMapKey(namespace, key));
  }

  async search(namespacePrefix: string[]): Promise<StoreItem[]> {
    const prefix = `${namespacePrefix.join("::")}@@`;
    return Array.from(this.data.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
  }

  async listNamespaces(): Promise<string[][]> {
    const seen = new Set<string>();
    const out: string[][] = [];
    for (const item of this.data.values()) {
      const key = item.namespace.join("::");
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item.namespace);
      }
    }
    return out;
  }

  async batch(ops: any[]): Promise<any[]> {
    const results: any[] = [];
    for (const op of ops ?? []) {
      const kind = String(op?.operation ?? op?.op ?? op?.type ?? "").toLowerCase();
      if (kind.includes("get")) {
        results.push(await this.get(op.namespace ?? op.path ?? [], op.key ?? ""));
      } else if (kind.includes("put")) {
        await this.put(op.namespace ?? op.path ?? [], op.key ?? "", op.value ?? {});
        results.push(null);
      } else if (kind.includes("delete")) {
        await this.delete(op.namespace ?? op.path ?? [], op.key ?? "");
        results.push(null);
      } else if (kind.includes("search")) {
        results.push(await this.search(op.namespacePrefix ?? op.namespace ?? []));
      } else if (kind.includes("list")) {
        results.push(await this.listNamespaces());
      } else {
        results.push(null);
      }
    }
    return results;
  }
}

const storeShim = new InMemoryStoreShim();

// ── Shared graph config ──
const baseGraphConfig = {
  configurable: {
    SKIP_USED_URLS_CHECK: true,
    SKIP_CONTENT_RELEVANCY_CHECK: true,
    skipUsedUrlsCheck: true,
    skipContentRelevancyCheck: true,
    textOnlyMode: true,
  },
  store: storeShim as any,
};

function graphConfigFor(ctx: any, scope: string) {
  const runId =
    String(ctx?.run?.id ?? ctx?.runId ?? ctx?.inputs?.run_id ?? "").trim() ||
    `run_${Date.now()}`;
  return {
    ...baseGraphConfig,
    configurable: {
      ...baseGraphConfig.configurable,
      thread_id: `${runId}:${scope}`,
    },
  };
}

// ── Helper: post via RunForge managed tools with approval ──
async function postToSocials(
  ctx: any,
  tools: ToolsFacade,
  postText: string,
  channels: string[],
  label: string,
) {
  if (channels.includes("twitter")) {
    await ctx.commitStep(
      `post_twitter_${label}`,
      async () => {
        await tools.twitter.postTweet(postText);
      },
      {
        description: `Post to Twitter/X: ${label}`,
        preview: { type: "tweet", text: postText.slice(0, 280) },
      },
    );
  }

  if (channels.includes("linkedin")) {
    await ctx.commitStep(
      `post_linkedin_${label}`,
      async () => {
        await tools.linkedin.postUpdate(postText);
      },
      {
        description: `Post to LinkedIn: ${label}`,
        preview: { type: "linkedin_post", text: postText.slice(0, 300) },
      },
    );
  }
}

// ── Helper: post thread via RunForge managed tools ──
async function postThread(
  ctx: any,
  tools: ToolsFacade,
  posts: Array<{ text: string }>,
) {
  // Twitter thread: post first tweet, reply to each subsequent
  await ctx.commitStep(
    "post_twitter_thread",
    async () => {
      await tools.twitter.postThread(
        posts.map((p) => ({ text: p.text })),
      );
    },
    {
      description: `Post Twitter thread (${posts.length} tweets)`,
      preview: {
        type: "thread",
        tweets: posts.length,
        first_tweet: posts[0]?.text.slice(0, 200),
      },
    },
  );

  // LinkedIn: post as single long-form (threads don't exist on LinkedIn)
  const linkedInText = posts.map((p) => p.text).join("\n\n---\n\n");
  await ctx.commitStep(
    "post_linkedin_thread",
    async () => {
      await tools.linkedin.postUpdate(linkedInText);
    },
    {
      description: "Post thread content to LinkedIn",
      preview: { type: "linkedin_post", text: linkedInText.slice(0, 300) },
    },
  );
}

// ══════════════════════════════════════════════════════
// MAIN AGENT
// ══════════════════════════════════════════════════════

runtime.agent("social-content-repurposer")(async (ctx: any, input: any) => {
  const mode = String(
    input.mode ?? ctx.inputs.mode ?? "single_post",
  ).trim();
  const url = String(
    input.content_url ?? ctx.inputs.content_url ?? "",
  ).trim();
  const channels = String(
    input.channels ?? ctx.inputs.channels ?? "twitter,linkedin",
  )
    .split(",")
    .map((c: string) => c.trim().toLowerCase());
  const numPosts = Number(input.num_posts ?? ctx.inputs.num_posts ?? 3);
  const contextUrls = String(input.context_urls ?? ctx.inputs.context_urls ?? "")
    .split(",")
    .map((u: string) => u.trim())
    .filter(Boolean);

  const tools = ctx.tools as ToolsFacade;

  // ── MODE 1: Single Post ──
  if (mode === "single_post") {
    if (!url) throw new Error("content_url is required for single_post mode");

    await ctx.safeStep("generate_post", async () => {
      const result = await generatePostGraph.invoke(
        { links: [url] },
        graphConfigFor(ctx, "single_post_generate"),
      );
      ctx.state.post = String(result.post ?? "");
      ctx.state.report = String(result.report ?? "");
      await ctx.artifact("report.md", ctx.state.report, "text/markdown");
      await ctx.artifact("post.md", ctx.state.post, "text/markdown");
    });

    await postToSocials(ctx, tools, ctx.state.post, channels, "post");

    await ctx.results.setStats({
      mode: "single_post",
      post_length: ctx.state.post.length,
      url,
    });
  }

  // ── MODE 2: Campaign (multiple posts from different angles) ──
  else if (mode === "campaign") {
    if (!url) throw new Error("content_url is required for campaign mode");

    await ctx.safeStep("generate_campaign", async () => {
      const result = await repurposerGraph.invoke(
        {
          originalLink: url,
          contextLinks: contextUrls.length > 0 ? contextUrls : undefined,
          quantity: numPosts,
        },
        graphConfigFor(ctx, "campaign_generate"),
      );

      const posts = result.posts ?? [];
      ctx.state.posts = posts;
      ctx.state.campaignPlan = String(result.campaignPlan ?? "");
      ctx.state.report = posts.length > 0
        ? (result.reports ?? []).map((r: any) => r.report).join("\n\n---\n\n")
        : "";

      // Save all posts as artifacts
      await ctx.artifact("campaign_plan.md", ctx.state.campaignPlan, "text/markdown");
      if (ctx.state.report) {
        await ctx.artifact("report.md", ctx.state.report, "text/markdown");
      }

      const draftsMarkdown = posts
        .map((p: any, i: number) => `## Post ${i + 1}\n\n${p.post}`)
        .join("\n\n---\n\n");
      await ctx.artifact("campaign_drafts.md", draftsMarkdown, "text/markdown");
    });

    // Approve and post each campaign post
    const posts = ctx.state.posts ?? [];
    for (let i = 0; i < posts.length; i++) {
      const postText = String(posts[i]?.post ?? "");
      if (postText) {
        await postToSocials(ctx, tools, postText, channels, `campaign_${i + 1}`);
      }
    }

    await ctx.results.setStats({
      mode: "campaign",
      posts_generated: posts.length,
      url,
      context_urls: contextUrls.length,
    });
  }

  // ── MODE 3: Twitter Thread ──
  else if (mode === "thread") {
    if (!url) throw new Error("content_url is required for thread mode");

    // Step 1: Generate report first
    await ctx.safeStep("generate_report", async () => {
      const reportResult = await generatePostGraph.invoke(
        { links: [url] },
        graphConfigFor(ctx, "thread_report"),
      );
      ctx.state.report = String(reportResult.report ?? "");
      await ctx.artifact("report.md", ctx.state.report, "text/markdown");
    });

    // Step 2: Generate thread from report
    await ctx.safeStep("generate_thread", async () => {
      const threadResult = await generateThreadGraph.invoke(
        {
          reports: [ctx.state.report],
        },
        graphConfigFor(ctx, "thread_generate"),
      );

      const threadPosts = threadResult.threadPosts ?? [];
      ctx.state.threadPosts = threadPosts;
      ctx.state.threadPlan = String(threadResult.threadPlan ?? "");

      await ctx.artifact("thread_plan.md", ctx.state.threadPlan, "text/markdown");

      const threadMarkdown = threadPosts
        .map((p: any, i: number) => `### Tweet ${i + 1}\n\n${p.text}`)
        .join("\n\n---\n\n");
      await ctx.artifact("thread_drafts.md", threadMarkdown, "text/markdown");
    });

    // Step 3: Post thread
    const threadPosts = ctx.state.threadPosts ?? [];
    if (threadPosts.length > 0) {
      await postThread(ctx, tools, threadPosts);
    }

    await ctx.results.setStats({
      mode: "thread",
      thread_length: threadPosts.length,
      url,
    });
  }

  // ── MODE 4: Content Curation (batch scan + generate) ──
  else if (mode === "curate") {
    await ctx.safeStep("curate_and_generate", async () => {
      const result = await supervisorGraph.invoke(
        {},
        graphConfigFor(ctx, "curate_generate"),
      );

      // Supervisor produces grouped reports + generated posts
      const posts = result.posts ?? [];
      ctx.state.posts = posts;
      ctx.state.curatedCount = posts.length;

      const draftsMarkdown = posts
        .map((p: any, i: number) => `## Post ${i + 1}\n\n${String(p.post ?? p)}`)
        .join("\n\n---\n\n");
      await ctx.artifact("curated_drafts.md", draftsMarkdown, "text/markdown");
    });

    // Approve and post each curated post
    const posts = ctx.state.posts ?? [];
    for (let i = 0; i < posts.length; i++) {
      const postText = String(posts[i]?.post ?? posts[i] ?? "");
      if (postText) {
        await postToSocials(ctx, tools, postText, channels, `curated_${i + 1}`);
      }
    }

    await ctx.results.setStats({
      mode: "curate",
      sources_scanned: "twitter,reddit,github",
      posts_generated: posts.length,
    });
  }

  // ── MODE 5: Repurpose (fresh angles on existing content) ──
  else if (mode === "repurpose") {
    if (!url) throw new Error("content_url is required for repurpose mode");

    await ctx.safeStep("repurpose_content", async () => {
      const result = await repurposerGraph.invoke(
        {
          originalLink: url,
          contextLinks: contextUrls.length > 0 ? contextUrls : undefined,
          quantity: numPosts,
        },
        graphConfigFor(ctx, "repurpose_generate"),
      );

      const posts = result.posts ?? [];
      ctx.state.posts = posts;
      ctx.state.campaignPlan = String(result.campaignPlan ?? "");

      await ctx.artifact("repurpose_plan.md", ctx.state.campaignPlan, "text/markdown");

      const draftsMarkdown = posts
        .map((p: any, i: number) => `## Post ${i + 1}\n\n${p.post}`)
        .join("\n\n---\n\n");
      await ctx.artifact("repurposed_drafts.md", draftsMarkdown, "text/markdown");
    });

    const posts = ctx.state.posts ?? [];
    for (let i = 0; i < posts.length; i++) {
      const postText = String(posts[i]?.post ?? "");
      if (postText) {
        await postToSocials(ctx, tools, postText, channels, `repurposed_${i + 1}`);
      }
    }

    await ctx.results.setStats({
      mode: "repurpose",
      posts_generated: posts.length,
      url,
    });
  }

  // ── Unknown mode ──
  else {
    throw new Error(
      `Unknown mode: "${mode}". Use: single_post, campaign, thread, curate, repurpose`,
    );
  }

  return {
    status: "completed",
    mode,
    channels,
  };
});

export { runtime };