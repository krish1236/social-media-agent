/**
 * RunForge entry: LangGraph generate-post runs in safeStep; Twitter/LinkedIn use platform tool connections.
 */
import { AgentRuntime, ToolsFacade } from "@runforge/sdk";
import { generatePostGraph } from "./src/agents/generate-post/generate-post-graph.js";

const runtime = new AgentRuntime();

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

  async put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
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
        // Unknown operation type: return null to avoid hard-failing the run.
        results.push(null);
      }
    }
    return results;
  }
}

const storeShim = new InMemoryStoreShim();

runtime.agent("social-content-repurposer")(async (ctx, input) => {
  const url = String(
    input.content_url ?? ctx.inputs.content_url ?? "",
  ).trim();
  if (!url) throw new Error("content_url is required");

  await ctx.safeStep("generate", async () => {
    const result = await generatePostGraph.invoke(
      {
        links: [url],
      },
      {
        configurable: {
          SKIP_USED_URLS_CHECK: true,
          SKIP_CONTENT_RELEVANCY_CHECK: true,
          skipUsedUrlsCheck: true,
          skipContentRelevancyCheck: true,
          textOnlyMode: true,
        },
        store: storeShim as any,
      },
    );
    const post = String(result.post ?? "");
    const report = String(result.report ?? "");
    ctx.state.post = post;
    ctx.state.report = report;
    await ctx.artifact("report.md", report, "text/markdown");
    await ctx.artifact("post.md", post, "text/markdown");
  });

  const postText = String(ctx.state.post ?? "");

  const tools = ctx.tools as ToolsFacade;

  await ctx.commitStep(
    "post_twitter",
    async () => {
      await tools.twitter.postTweet(postText);
    },
    {
      description: "Post to Twitter/X",
      preview: { type: "tweet", text: postText.slice(0, 200) },
    },
  );

  await ctx.commitStep(
    "post_linkedin",
    async () => {
      await tools.linkedin.postUpdate(postText);
    },
    {
      description: "Post to LinkedIn",
      preview: { type: "linkedin_post", text: postText.slice(0, 200) },
    },
  );

  await ctx.results.setStats({
    post_length: postText.length,
    url,
  });

  return { status: "completed" };
});

export { runtime };
