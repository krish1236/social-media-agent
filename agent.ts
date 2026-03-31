/**
 * RunForge entry: LangGraph generate-post runs in safeStep; Twitter/LinkedIn use platform tool connections.
 */
import { AgentRuntime, ToolsFacade } from "@runforge/sdk";
import { generatePostGraph } from "./src/agents/generate-post/generate-post-graph.js";

const runtime = new AgentRuntime();

runtime.agent("social-content-repurposer")(async (ctx, input) => {
  const url = String(
    input.content_url ?? ctx.inputs.content_url ?? "",
  ).trim();
  if (!url) throw new Error("content_url is required");

  await ctx.safeStep("generate", async () => {
    const result = await generatePostGraph.invoke({
      links: [url],
    });
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
