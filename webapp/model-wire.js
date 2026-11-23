// Shared bot/web transport. Internal requests and responses use content blocks.
const { createHash } = require("crypto");
const policy = require("./model-policy");
function convertToolToOpenAI(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  };
}

function convertMessagesToOpenAI(systemPrompt, messages, identity) {
  const out = [];
  // System can be an array of blocks (Anthropic prompt-caching shape): flatten to string
  if (Array.isArray(systemPrompt)) systemPrompt = systemPrompt.map(b => b?.text || "").join("");
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      out.push({ role: msg.role, content: String(msg.content ?? "") });
      continue;
    }

    if (msg.role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        }
        // Skip thinking blocks
      }
      // A turn with neither text nor a tool call still has to carry content:
      // DeepSeek refuses null there ("content or tool_calls must be set").
      const converted = { role: "assistant", content: textParts.join("\n") || (toolCalls.length > 0 ? null : "") };
      if (toolCalls.length > 0) converted.tool_calls = toolCalls;
      const replay = msg.content.find(b => b.type === "provider_state" && b.identity === identity);
      if (replay) Object.assign(converted, replay.value);
      out.push(converted);

    } else if (msg.role === "user") {
      const toolResults = [];
      const otherParts = []; // can be strings or objects (for multimodal)
      let hasMultimodal = false;
      for (const block of msg.content) {
        if (block.type === "tool_result") toolResults.push(block);
        else if (block.type === "text") otherParts.push({ type: "text", text: block.text });
        else if (block.type === "image" && block.source?.data) {
          // Convert Anthropic image format to OpenAI image_url format
          hasMultimodal = true;
          otherParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type || "image/jpeg"};base64,${block.source.data}` },
          });
        }
        else if (block.type === "video" && (block.source?.data || block.source?.url)) {
          // The OpenAI-compatible video part (OpenRouter, vLLM, Qwen's services).
          hasMultimodal = true;
          otherParts.push({ type: "video_url", video_url: { url: block.source.data ? `data:${block.source.media_type || "video/mp4"};base64,${block.source.data}` : block.source.url } });
        }
        else if (block.type === "document") otherParts.push({ type: "text", text: `[Document: ${block.source?.filename || block.filename || "file"}]` });
        else otherParts.push({ type: "text", text: block.text || "" });
      }
      // Images returned BY a tool need care here. The OpenAI-compatible chat
      // format has no way to put an image inside a role:"tool" message, and
      // this used to flatten them to the literal string "[Image]", so a
      // screenshot or an attachment the model had just fetched arrived as two
      // words and it stayed blind to its own tool output. They are carried
      // across as a user message straight after the tool results instead,
      // which is the only slot the format allows an image to travel in.
      const toolImages = [];
      for (const tr of toolResults) {
        let content = tr.content;
        if (typeof content === "object" && content !== null) {
          if (Array.isArray(content)) {
            content = content.map((b) => {
              if (b.type === "text") return b.text;
              if (b.type === "image" && b.source?.data) {
                toolImages.push({
                  type: "image_url",
                  image_url: { url: `data:${b.source.media_type || "image/jpeg"};base64,${b.source.data}` },
                });
                return "[image follows below]";
              }
              return JSON.stringify(b);
            }).join("\n");
          } else {
            content = JSON.stringify(content);
          }
        }
        out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: (tr.is_error ? "Error: " : "") + (content || "") });
      }
      if (toolImages.length > 0) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: toolImages.length === 1
                ? "This is the image returned by the tool call above."
                : `These are the ${toolImages.length} images returned by the tool calls above.` },
            ...toolImages,
          ],
        });
      }
      if (otherParts.length > 0) {
        // If there are images, send as multimodal content array; otherwise flatten to string
        if (hasMultimodal) {
          out.push({ role: "user", content: otherParts });
        } else {
          out.push({ role: "user", content: otherParts.map(p => p.text || "").join("\n") });
        }
      }

    } else {
      const text = msg.content.map((b) => b.text || "").filter(Boolean).join("\n");
      out.push({ role: msg.role, content: text || "" });
    }
  }
  return out;
}

function convertResponseFromOpenAI(openaiResponse, identity) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };

  const message = choice.message || {};
  const content = [];
  const state = {};
  for (const field of ["reasoning_content", "reasoning_details"]) {
    if (message[field] !== undefined) state[field] = message[field];
  }
  if (Object.keys(state).length) content.push({ type: "provider_state", identity, value: state });
  if (message.content) {
    // Strip reasoning tags (<think>...</think>) some models emit; keep only the visible response
    let text = message.content;
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    content.push({ type: "text", text });
  }
  if (message.tool_calls?.length > 0) {
    for (const tc of message.tool_calls) {
      let parsed;
      try { parsed = JSON.parse(tc.function.arguments); } catch { parsed = tc.function.arguments; }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsed });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  // A reply cut off by the output limit is unfinished whatever it holds: a
  // tool call in it may have half its arguments. Otherwise tool calls make it
  // a tool turn, whichever finish reason the provider gave alongside them.
  const stopReason = choice.finish_reason === "length" ? "max_tokens"
    : choice.finish_reason === "tool_calls" || message.tool_calls?.length > 0 ? "tool_use" : "end_turn";

  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: Math.max(openaiResponse.usage?.completion_tokens || 0,
        (openaiResponse.usage?.total_tokens || 0) - (openaiResponse.usage?.prompt_tokens || 0)),
      reasoning_tokens: openaiResponse.usage?.completion_tokens_details?.reasoning_tokens || 0,
      cost_in_usd_ticks: openaiResponse.usage?.cost_in_usd_ticks ?? null,
      // Cache hits: prompt_tokens_details (xAI, OpenAI, OpenRouter) or
      // prompt_cache_hit_tokens (DeepSeek), counted inside input_tokens.
      cache_read_input_tokens: openaiResponse.usage?.prompt_tokens_details?.cached_tokens || openaiResponse.usage?.prompt_cache_hit_tokens || 0,
      input_includes_cache: true,
      // What the call cost, where the provider says so (OpenRouter's usage.cost, in dollars).
      cost_usd: typeof openaiResponse.usage?.cost === "number" ? openaiResponse.usage.cost : null,
    },
  };
}

// =============================================================================
// Anthropic -> Gemini format conversion
// =============================================================================

function convertToolToGemini(tool) {
  return {
    name: tool.name,
    description: tool.description || "",
    parameters: tool.input_schema || { type: "object", properties: {} },
  };
}

function convertMessagesToGemini(systemPrompt, messages, identity) {
  // Gemini uses { contents: [...], systemInstruction: { parts: [...] } }
  // System can be an array of blocks (Anthropic prompt-caching shape): flatten to string
  if (Array.isArray(systemPrompt)) systemPrompt = systemPrompt.map(b => b?.text || "").join("");
  const contents = [];

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block._geminiPart && block._identity === identity) {
          parts.push(block._geminiPart);
        } else if (block.type === "provider_state") {
          if (block.identity === identity && block.geminiPart) parts.push(block.geminiPart);
        } else if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({ functionCall: { name: block.name, args: block.input || {} } });
        } else if (block.type === "tool_result") {
          // Gemini: tool results go in a user message with functionResponse parts
          parts.push({
            functionResponse: {
              name: block.name || block._toolName || "unknown",
              response: typeof block.content === "string" ? { result: block.content }
                : Array.isArray(block.content) ? { result: block.content.map(b => b.text || JSON.stringify(b)).join("\n") }
                : { result: JSON.stringify(block.content) },
            },
          });
        } else if (block.type === "image") {
          if (block.source?.data) {
            parts.push({ inlineData: { mimeType: block.source.media_type || "image/png", data: block.source.data } });
          }
        } else if (block.type === "video") {
          // A YouTube link is opened by Gemini itself; anything else is sent inline.
          if (block.source?.url) parts.push({ fileData: { fileUri: block.source.url } });
          else if (block.source?.data) parts.push({ inlineData: { mimeType: block.source.media_type || "video/mp4", data: block.source.data } });
        }
        // Skip thinking, document blocks
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  return { contents, systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined };
}

function convertResponseFromGemini(geminiResponse, identity) {
  const candidate = geminiResponse.candidates?.[0];
  if (!candidate) return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };

  const content = [];
  let hasToolCalls = false;

  for (const part of candidate.content?.parts || []) {
    if (part.thought) {
      content.push({ type: "provider_state", identity, geminiPart: part });
    } else if (part.text) {
      content.push({ type: "text", text: part.text, _identity: identity, _geminiPart: part });
    } else if (part.functionCall) {
      hasToolCalls = true;
      content.push({
        type: "tool_use", _identity: identity, _geminiPart: part,
        id: `toolu_${Math.random().toString(36).slice(2, 14)}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  const stopReason = hasToolCalls ? "tool_use"
    : candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";

  const usage = {
    input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
    output_tokens: (geminiResponse.usageMetadata?.candidatesTokenCount || 0) + (geminiResponse.usageMetadata?.thoughtsTokenCount || 0),
    cache_read_input_tokens: geminiResponse.usageMetadata?.cachedContentTokenCount || 0,
    input_includes_cache: true,
  };

  return { content, stop_reason: stopReason, usage };
}

// =============================================================================
// Patch tool_result blocks with tool names (needed for Gemini which has no IDs)
// =============================================================================

function enrichToolResults(messages) {
  // Build a map of tool_use_id -> tool_name from assistant messages
  const idToName = {};
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") idToName[block.id] = block.name;
    }
  }
  // Patch tool_result blocks with _toolName
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        block._toolName = idToName[block.tool_use_id] || "unknown";
      }
    }
  }
}

// =============================================================================
// Client factory
// =============================================================================


// Prompt caching. Anthropic caches only what is marked; OpenAI, DeepSeek,
// Gemini and most others reuse a repeated prompt start automatically, so for
// them the marks are dropped in translation and a stable start is what counts.
// The system prompt comes after the tools, so marking it caches both. In the
// middle of a task, after tool results, the conversation so far is marked
// too: the next step resends it within seconds. The tools are marked where a
// mark is left, so a system prompt that changed (a fact pinned) still reads
// them from cache. The model sees exactly the same prompt either way.
// Anthropic allows four marks; a caller's own count.
const CACHE_MARK = { type: "ephemeral" };
function markCache(body) {
  const marked = b => !!b?.cache_control;
  if (typeof body.system === "string" && body.system) body.system = [{ type: "text", text: body.system, cache_control: CACHE_MARK }];
  else if (Array.isArray(body.system) && body.system.length && !body.system.some(marked)) {
    body.system = body.system.map((b, i) => i === body.system.length - 1 ? { ...b, cache_control: CACHE_MARK } : b);
  }
  const last = body.messages[body.messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content) && last.content.some(b => b.type === "tool_result") && !last.content.some(marked)) {
    const i = last.content.length - 1;
    last.content[i] = { ...last.content[i], cache_control: CACHE_MARK };
  }
  if (Array.isArray(body.tools) && body.tools.length && !body.tools.some(marked)) {
    body.tools = body.tools.map((t, i) => i === body.tools.length - 1 ? { ...t, cache_control: CACHE_MARK } : t);
  }
  // Never more than four. A request carried on from the last reply keeps the
  // marks it was sent with, one more each time, and the fourth quick follow-up
  // in a row had five and was refused. The conversation's earliest marks go
  // first, as the newest are what the next step reads; then the tools'.
  const inMessages = [];
  body.messages.forEach((m, mi) => { if (Array.isArray(m.content)) m.content.forEach((b, bi) => { if (marked(b)) inMessages.push([mi, bi]); }); });
  let over = (Array.isArray(body.system) ? body.system.filter(marked).length : 0) + inMessages.length + (body.tools || []).filter(marked).length - 4;
  for (const [mi, bi] of inMessages) {
    if (over <= 0) break;
    const { cache_control, ...plain } = body.messages[mi].content[bi];
    body.messages[mi].content[bi] = plain;
    over--;
  }
  if (over > 0 && Array.isArray(body.tools)) body.tools = body.tools.map(({ cache_control, ...t }) => t);
}
function identity(conn, model) {
  return createHash("sha256").update([conn.baseUrl, conn.apiKey || "", model].join("|")).digest("hex");
}
// The system prompt and tools a reply was written under, as Anthropic binds
// its reasoning to them: the words, and the tools in any order. Cache marks
// are not part of it.
function writtenUnder(system, tools) {
  const words = typeof system === "string" ? [system] : (system || []).map(b => b?.text ?? "");
  const set = (tools || []).map(({ cache_control, ...t }) => JSON.stringify(t)).sort();
  return createHash("sha256").update(JSON.stringify([words, set])).digest("hex");
}
function withoutThinking(messages) {
  return (messages || []).map(m => Array.isArray(m.content)
    ? { ...m, content: m.content.filter(b => !["thinking", "redacted_thinking"].includes(b?.type)) } : m);
}
// API keys have shapes model IDs never have: a provider's key prefix, or a
// long unbroken run of letters and digits. A key pasted where a model ID goes
// is never sent as a model name (providers repeat the name in their errors),
// and nothing key-shaped from a provider's error reaches the log.
const KEY_PREFIX = /^(?:sk-|sk_|xai-|gsk_|AIza|pplx-|hf_|r8_|nvapi-|fw_|csk-)/;
const KEY_RUN = /[A-Za-z0-9]{32,}/g;
const longRunIsKey = (run) => /\d/.test(run) && /[A-Za-z]/.test(run);
function looksLikeKey(text) {
  const s = String(text || "").trim();
  return KEY_PREFIX.test(s) || (s.match(KEY_RUN) || []).some(longRunIsKey);
}
function hideKeys(text, conn) {
  let out = String(text || "");
  if (conn?.apiKey) out = out.split(conn.apiKey).join("<hidden>");
  return out.replace(/\b(?:sk-|sk_|xai-|gsk_|AIza|pplx-|hf_|r8_|nvapi-|fw_|csk-)[A-Za-z0-9_-]{8,}/g, "<hidden>")
    .replace(KEY_RUN, (run) => (longRunIsKey(run) ? "<hidden>" : run));
}
const KEY_AS_MODEL = "That looks like an API key, not a model ID, so Closedhand didn't send it anywhere. To use another provider, choose it under Provider and paste the key in its API key box.";
// Models that refused to skip thinking; their fast jobs think as little as they allow.
const mustThink = new Set();
// A runner on this computer that has stopped or is still loading its model.
function runnerAway(e) {
  const code = e?.cause?.code || e?.code;
  return e?.status === 503 || ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_CLOSED"].includes(code) || /fetch failed/i.test(String(e?.message || ""));
}
// --- A reply as it is written ---------------------------------------------------
// With options.onText a request asks its provider for the reply as it is
// written and hands each stretch of the answer's words to onText as it
// arrives. What request() returns is the same whole reply either way, put
// together here from the pieces, so nothing downstream changes; tool calls are
// only ever read from that whole reply.

// Server-sent events: each one's data, parsed, goes to each.
async function events(response, each, heard = null) {
  const decoder = new TextDecoder();
  let rest = "";
  const take = (last) => {
    for (let m; (m = /\r?\n\r?\n/.exec(rest)) || (last && rest.trim());) {
      const event = m ? rest.slice(0, m.index) : rest;
      rest = m ? rest.slice(m.index + m[0].length) : "";
      const data = event.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      each(json);
    }
  };
  for await (const chunk of response.body) { if (heard) heard(); rest += decoder.decode(chunk, { stream: true }); take(false); }
  take(true);
}
// Tells a provider that never answered from one still writing a long reply.
// The second runs out of time with words arriving; the first sends nothing at
// all before the time is up, and only it is worth asking again, so it is
// marked `stalled` for the caller (lib/engine.js). A reply written out counts
// as heard from its first piece; one sent whole gives no sign until it is
// done, so it counts from the provider's first line of response. Silence part
// way through is not judged: some models think for minutes without a word. A
// caller's own signal (a job stopped, a check's short limit) is that
// caller's business, never a stall.
function stallWatch(outer, { ours = true } = {}) {
  const control = new AbortController();
  let heard = false, nothingCame = false;
  const onOuter = () => { nothingCame = !heard; control.abort(outer.reason); };
  if (outer.aborted) onOuter(); else outer.addEventListener("abort", onOuter, { once: true });
  return {
    signal: control.signal,
    heard() { heard = true; },
    done() { outer.removeEventListener("abort", onOuter); },
    stalled: () => ours && nothingCame,
  };
}
// The answer's words without what some models think aloud between <think>
// tags, which can open or close anywhere across pieces.
function visible(onText) {
  let hidden = false, held = "";
  return (text) => {
    held += text;
    let out = "";
    for (;;) {
      const tag = hidden ? "</think>" : "<think>", at = held.indexOf(tag);
      if (at < 0) break;
      if (!hidden) out += held.slice(0, at);
      held = held.slice(at + tag.length);
      hidden = !hidden;
    }
    // What could be the start of a tag waits for the next piece.
    const tag = hidden ? "</think>" : "<think>";
    let keep = 0;
    for (let n = Math.min(tag.length - 1, held.length); n > 0; n--) if (tag.startsWith(held.slice(-n))) { keep = n; break; }
    if (!hidden) out += held.slice(0, held.length - keep);
    held = held.slice(held.length - keep);
    if (out) { try { onText(out); } catch (_) { /* the listener's own trouble */ } }
  };
}
const cutShort = () => Object.assign(new Error("The model provider's reply stopped part way."), { status: 502, code: "reply_cut_short" });
// OpenAI's shape, which most providers speak: pieces of the message (delta).
function openaiPieces(onText) {
  const message = { role: "assistant", content: "" }, calls = [], details = [];
  let id = null, model = null, usage = null, finish = null;
  const say = visible(onText);
  return {
    take(piece) {
      id = id || piece.id; model = model || piece.model;
      if (piece.usage) usage = piece.usage;
      const choice = piece.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta || {};
      if (typeof d.content === "string" && d.content) { message.content += d.content; say(d.content); }
      if (typeof d.reasoning_content === "string") message.reasoning_content = (message.reasoning_content || "") + d.reasoning_content;
      // OpenRouter's reasoning, kept to hand back: each entry arrives in stretches under its index.
      for (const [n, part] of (Array.isArray(d.reasoning_details) ? d.reasoning_details : []).entries()) {
        const i = Number.isInteger(part?.index) ? part.index : n, kept = details[i] = details[i] || {};
        for (const [k, v] of Object.entries(part || {})) kept[k] = ["text", "summary", "data"].includes(k) && typeof v === "string" && typeof kept[k] === "string" ? kept[k] + v : v ?? kept[k];
      }
      // A tool call: its id and name once, its arguments a stretch at a time.
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const i = Number.isInteger(tc.index) ? tc.index : tc.id || tc.function?.name ? calls.length : Math.max(0, calls.length - 1);
        const call = calls[i] = calls[i] || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name && tc.function.name !== call.function.name) call.function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") call.function.arguments += tc.function.arguments;
      }
    },
    whole() {
      if (!finish) throw cutShort();
      if (calls.some(Boolean)) message.tool_calls = calls.filter(Boolean);
      if (details.some(Boolean)) message.reasoning_details = details.filter(Boolean);
      return { id, model, choices: [{ index: 0, message, finish_reason: finish }], usage };
    },
  };
}
// Anthropic's events: the message, then each block of it in stretches.
function anthropicPieces(onText) {
  const blocks = [], json = [];
  let message = null, failed = null;
  return {
    take(event) {
      const block = blocks[event.index], d = event.delta || {};
      if (event.type === "message_start") message = { ...event.message };
      else if (event.type === "content_block_start") { blocks[event.index] = { ...event.content_block }; if (event.content_block?.type === "tool_use") json[event.index] = ""; }
      else if (event.type === "content_block_delta" && block) {
        if (d.type === "text_delta") { block.text = (block.text || "") + d.text; try { onText(d.text); } catch (_) { /* the listener's own trouble */ } }
        else if (d.type === "input_json_delta") json[event.index] += d.partial_json || "";
        else if (d.type === "thinking_delta") block.thinking = (block.thinking || "") + d.thinking;
        else if (d.type === "signature_delta") block.signature = d.signature;
      } else if (event.type === "content_block_stop" && block && json[event.index] !== undefined) {
        try { block.input = json[event.index] ? JSON.parse(json[event.index]) : {}; } catch { failed = failed || cutShort(); }
      } else if (event.type === "message_delta") message = { ...message, ...d, usage: { ...message?.usage, ...event.usage } };
      else if (event.type === "error") failed = Object.assign(new Error("The model provider returned an error part way through its reply."), { status: event.error?.type === "overloaded_error" ? 529 : 500 });
    },
    whole() {
      if (failed) throw failed;
      if (!message?.stop_reason) throw cutShort();
      return { ...message, content: blocks.filter(Boolean) };
    },
  };
}
// Gemini's: a whole response each time, holding the next parts.
function geminiPieces(onText) {
  const parts = [];
  let usage = null, finish = null;
  return {
    take(event) {
      if (event.usageMetadata) usage = event.usageMetadata;
      const candidate = event.candidates?.[0];
      if (!candidate) return;
      if (candidate.finishReason) finish = candidate.finishReason;
      for (const part of candidate.content?.parts || []) {
        const last = parts.at(-1), words = typeof part.text === "string" && !part.functionCall;
        // Stretches of the same text join up; anything a later stretch carries (its signature) stays with it.
        if (words && last && typeof last.text === "string" && !last.functionCall && !!last.thought === !!part.thought) Object.assign(last, part, { text: last.text + part.text });
        else parts.push({ ...part });
        if (words && part.text && !part.thought) { try { onText(part.text); } catch (_) { /* the listener's own trouble */ } }
      }
    },
    whole() {
      if (!finish) throw cutShort();
      return { candidates: [{ content: { role: "model", parts }, finishReason: finish }], usageMetadata: usage };
    },
  };
}
// A provider that would not write its reply out is asked for it whole from then on.
const wholeOnly = new Set();

// Told of every request, where the process wants to know (the bot counts
// them as Closedhand being busy, lib/idle.js).
let _onRequest = null;
function onRequest(fn) { _onRequest = fn; }

async function request(conn, params, options = {}) {
  if (_onRequest) _onRequest();
  // A job run on this computer (webapp/run-here.js) goes to the person's
  // provider for any request its runner can't take.
  if (conn.fallback) {
    try { return await request({ ...conn, fallback: null }, params, options); }
    catch (e) {
      if (!runnerAway(e)) throw e;
      return request(conn.fallback, { ...params, model: conn.fallback.model }, options);
    }
  }
  const model = params.model || conn.model;
  if (looksLikeKey(model)) throw Object.assign(new Error(KEY_AS_MODEL), { status: 400, code: "model_id_is_key" });
  const cap = conn.capabilities || policy.capabilities(conn, model);
  // Video only goes to a model known to take it; the caller falls back to frames.
  const hasVideo = (params.messages || []).some(m => Array.isArray(m.content) && m.content.some(b => b.type === "video"));
  if (hasVideo && cap.video !== true) throw Object.assign(new Error("This model doesn't take video."), { status: 400, code: "video_not_supported" });
  const id = identity(conn, model);
  const effort = params.effort || (params.thinking?.type === "enabled" ? "strong" : "default");
  const max = params.max_tokens || 4096;
  const controls = policy.effortOptions(cap, effort, max);
  if (controls.reasoning?.enabled === false && mustThink.has(model)) controls.reasoning = { effort: "low" };
  const headers = { "Content-Type": "application/json" };
  const written = [conn.backend, conn.baseUrl, model].join("|");
  const onText = typeof options.onText === "function" && !wholeOnly.has(written) ? options.onText : null;
  let url, body, convert, live = null;
  if (conn.backend === "anthropic") {
    headers["x-api-key"] = conn.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    // Claude's reasoning holds only under the system prompt and tools it was
    // written with: Anthropic refuses it once either changes ("bound to a
    // different conversation"), as when a reply loads another tool midway.
    const bound = id + "|" + writtenUnder(params.system, params.tools);
    // Only what the API defines: a saved turn can carry Closedhand's own
    // fields (what a nudge was about), which Anthropic refuses.
    const messages = (params.messages || []).map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.filter(b =>
      b.type !== "provider_state" && (!["thinking", "redacted_thinking"].includes(b.type) || b._identity === bound)
    ).map(b => {
      const { _geminiPart, _identity, ...clean } = b; return clean;
    }) : m.content }));
    body = { model, messages, max_tokens: max, ...controls };
    if (params.system) body.system = params.system;
    if (params.tools?.length) body.tools = params.tools;
    if (params.tool_choice) body.tool_choice = params.tool_choice;
    markCache(body);
    url = conn.baseUrl + "/messages";
    if (onText) { body.stream = true; live = anthropicPieces(onText); }
    convert = data => ({ ...data, content: data.content?.map(b => ["thinking", "redacted_thinking"].includes(b.type) ? { ...b, _identity: bound } : b) });
  } else if (conn.backend === "gemini") {
    const source = structuredClone(params.messages || []);
    enrichToolResults(source);
    const { contents, systemInstruction } = convertMessagesToGemini(params.system, source, id);
    body = { contents, generationConfig: { maxOutputTokens: max, ...controls } };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (params.tools?.length) body.tools = [{ functionDeclarations: params.tools.map(convertToolToGemini) }];
    if (params.tool_choice?.type === "any") body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    headers["x-goog-api-key"] = conn.apiKey;
    url = conn.baseUrl + "/models/" + encodeURIComponent(model) + (onText ? ":streamGenerateContent?alt=sse" : ":generateContent");
    if (onText) live = geminiPieces(onText);
    convert = data => convertResponseFromGemini(data, id);
  } else {
    if (conn.apiKey) headers.Authorization = "Bearer " + conn.apiKey;
    body = { model, messages: convertMessagesToOpenAI(params.system, params.messages || [], id), ...controls };
    body[cap.reasoning === "openai" ? "max_completion_tokens" : "max_tokens"] = max;
    if (params.tools?.length) {
      body.tools = params.tools.map(convertToolToOpenAI);
      body.tool_choice = params.tool_choice?.type === "any" ? "required" : params.tool_choice?.type === "tool"
        ? { type: "function", function: { name: params.tool_choice.name } } : "auto";
    }
    // include_usage: the last piece then says what the reply used.
    if (onText) { body.stream = true; body.stream_options = { include_usage: true }; live = openaiPieces(onText); }
    url = conn.baseUrl + "/chat/completions"; convert = data => convertResponseFromOpenAI(data, id);
  }
  named(conn, headers);
  // As long as the engine waits for a reply (lib/engine.js, three minutes): a
  // reply to a long conversation took more than the 90 seconds this once
  // allowed, and was cut off with the engine still waiting.
  const watch = stallWatch(options.signal || AbortSignal.timeout(options.limitMs || 180000), { ours: !options.signal });
  const signal = watch.signal;
  try {
  // NEAR AI: proven, end-to-end encrypted and signature-checked (near-private.js).
  const near = require("./near-private");
  // Its pieces are opened on this computer as they arrive; the reply is used
  // only once the sealed hardware has signed for all of it.
  const response = conn.backend === "custom" && near.isNear(conn) ? await near.complete(conn, body, { signal, ...(live ? { onChunk: (piece) => { watch.heard(); return live.take(piece); } } : {}) })
    : await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
  if (!live || !response.ok) watch.heard();
  // What the provider says is left this minute, for whoever is pacing calls.
  if (options.onLimits) { try { options.onLimits(limitsFrom(response.headers), response.status); } catch (_) {} }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const said = String(detail.error?.message || "");
    if (response.status === 400 && (/context.*(?:length|window|size)|maximum.*(?:prompt|tokens)/i.test(said) || /exceed_context/i.test(String(detail.error?.type || "")))) {
      // How much the model could take and how much was sent, when the
      // provider says (Ollama does), so a caller can trim to fit.
      const limit = Number(detail.error?.n_ctx) || Number((said.match(/context size \((\d+) tokens\)/i) || [])[1]) || null;
      const used = Number(detail.error?.n_prompt_tokens) || Number((said.match(/request \((\d+) tokens\)/i) || [])[1]) || null;
      throw Object.assign(new Error("The model context window was exceeded."), { status: 400, code: "context_length_exceeded", limit, used });
    }
    // Anything else earlier in the reply that changed since Claude reasoned:
    // asked once more without that reasoning, as Anthropic says to, and the
    // change is logged with the message Anthropic names, to be found.
    if (response.status === 400 && conn.backend === "anthropic" && /bound to a different conversation/i.test(said)
      && body.messages.some(m => Array.isArray(m.content) && m.content.some(b => ["thinking", "redacted_thinking"].includes(b.type)))) {
      console.warn(`[model-wire] anthropic refused earlier reasoning, sent again without it: ${hideKeys(said, conn).slice(0, 400)}`);
      return request(conn, { ...params, messages: withoutThinking(params.messages) }, options);
    }
    if (response.status === 400 && body.reasoning?.enabled === false && /reasoning is mandatory/i.test(said)) {
      mustThink.add(model);
      return request(conn, params, options);
    }
    // Asked to write its reply out and refusing the request for a reason not
    // known above: asked again for the whole reply, and from then on if that
    // is what it takes.
    if (live && [400, 404, 405, 415, 422, 501].includes(response.status)) {
      const whole = await request(conn, params, { ...options, onText: null });
      wholeOnly.add(written);
      console.warn(`[model-wire] ${conn.provider || conn.backend} would not write its reply out (HTTP ${response.status}); asking for whole replies`);
      return whole;
    }
    // The provider's own message goes to the log, trimmed, so a 400 can be
    // diagnosed; never to the user, and never the body, which can carry the request.
    if (detail.error?.message) console.warn(`[model-wire] ${conn.provider || conn.backend} HTTP ${response.status}: ${hideKeys(detail.error.message, conn).slice(0, 200)}`);
    const error = new Error("The model provider returned HTTP " + response.status + ". " + providerProblem(response.status, "Check the model, access and balance."));
    error.status = response.status;
    // OpenRouter refuses a key past its own spending limit with 403, not 402.
    if (response.status === 403 && (detail.error?.metadata?.limit_source === "openrouter_key_limit" || /key limit/i.test(said))) error.code = "key_limit";
    Object.assign(error, refusal(response, detail, said));
    throw error;
  }
  if (!live) return convert(await response.json());
  if (!(conn.backend === "custom" && near.isNear(conn))) await events(response, live.take, watch.heard);
  return convert(live.whole());
  } catch (error) {
    if (!watch.stalled() || error.status) throw error;
    throw Object.assign(new Error("The model stopped answering (timeout)."), { code: "MODEL_STALLED", stalled: true, cause: error });
  } finally {
    watch.done();
  }
}
// How much a provider says is left, from the headers it sends with every
// reply: Anthropic's anthropic-ratelimit-*, and the x-ratelimit-* that
// OpenAI, Groq and others use. Null when it sends none.
function limitsFrom(headers) {
  const get = (name) => { try { return headers?.get?.(name) ?? null; } catch (_) { return null; } };
  const num = (name) => { const v = Number(get(name)); return get(name) != null && Number.isFinite(v) ? v : null; };
  const out = {
    requestsLimit: num("anthropic-ratelimit-requests-limit") ?? num("x-ratelimit-limit-requests"),
    requestsLeft: num("anthropic-ratelimit-requests-remaining") ?? num("x-ratelimit-remaining-requests"),
    tokensLimit: num("anthropic-ratelimit-input-tokens-limit") ?? num("anthropic-ratelimit-tokens-limit") ?? num("x-ratelimit-limit-tokens"),
    tokensLeft: num("anthropic-ratelimit-input-tokens-remaining") ?? num("anthropic-ratelimit-tokens-remaining") ?? num("x-ratelimit-remaining-tokens"),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}
// How long the provider asks to wait: Retry-After in seconds or as a date,
// else the reset OpenAI-style providers give ("1s", "6m0s"). Null if none.
function waitAsked(headers) {
  const get = (name) => { try { return headers?.get?.(name) ?? null; } catch (_) { return null; } };
  const after = get("retry-after");
  if (after != null) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const reset = String(get("x-ratelimit-reset-requests") || get("x-ratelimit-reset-tokens") || "");
  const m = reset.match(/^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:(\d+)ms)?$/);
  if (reset && m && m[0]) return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0);
  return null;
}
// Whether waiting helps. A per-minute limit, a busy provider or OpenRouter's
// short hold on credit for running requests clears by itself: waitable. A
// spending cap, a used-up quota or credit, or a budget does not clear today:
// allowance, with when it comes back where the provider says.
function refusal(response, detail, said) {
  const status = response.status, err = detail.error || {}, meta = err.metadata || {};
  const code = String(err.details?.error_code || err.error_code || err.code || err.type || meta.reason || "");
  const resetsAt = meta.resets_at || null;
  const used = code === "enforced_spend_limit_reached" || code === "insufficient_quota" || /reached your specified API usage limits/i.test(said)
    || (status === 402 && meta.reason !== "in_flight_budget_exhausted")
    || (status === 403 && /^openrouter_(guardrail_budget|workspace_budget|key_limit)$/.test(String(meta.limit_source || "")));
  if (used) return { allowance: true, resetsAt, waitable: false };
  if (status === 429 || status === 503 || status === 529 || (status === 402 && meta.reason === "in_flight_budget_exhausted")) {
    return { waitable: true, retryAfterMs: waitAsked(response.headers) };
  }
  return {};
}
// OpenRouter credits the traffic to the app that names itself; nothing about
// the person goes with it. Every call to an LLM endpoint adds these, so none
// shows there as an unknown app.
function appHeaders(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch (_) {}
  return host === "openrouter.ai" ? { "HTTP-Referer": "https://closedhand.com", "X-Title": "Closedhand" } : {};
}
function named(conn, headers) {
  Object.assign(headers, appHeaders(conn.baseUrl));
}
// What a provider's status code means for the person reading it. Bodies are never echoed.
function providerProblem(status, fallback) {
  return { 401: "The provider rejected the API key.", 402: "The provider says this account needs payment or more credit.",
    403: "The provider refused this key access to the model.", 404: "The provider has no model with this ID.",
    429: "The provider is limiting requests right now. Try again shortly." }[status] || fallback;
}
async function listModels(conn) {
  const headers = {};
  if (conn.backend === "anthropic") Object.assign(headers, { "x-api-key": conn.apiKey, "anthropic-version": "2023-06-01" });
  else if (conn.backend === "gemini") headers["x-goog-api-key"] = conn.apiKey;
  else if (conn.apiKey) headers.Authorization = "Bearer " + conn.apiKey;
  named(conn, headers);
  const response = await fetch(conn.baseUrl + "/models", { headers, signal: AbortSignal.timeout(12000), redirect: "error" });
  if (!response.ok) { const e = new Error("Could not load models (HTTP " + response.status + "). " + providerProblem(response.status, "You can enter the model ID.")); e.status = response.status; throw e; }
  const data = await response.json();
  const models = (data.data || data.models || []).map(m => ({ id: (m.id || m.name || "").replace(/^models\//, ""), metadata: m })).filter(m => m.id);
  if (conn.provider === "ollama") await describeOllama(conn, models);
  // NEAR AI: only the models whose privacy can be proven (near-private.js).
  if (conn.backend === "custom" && require("./near-private").isNear(conn)) return require("./near-private").provenModels(conn, models);
  return models;
}
// Ollama's model list says nothing about what each model can do, but its own
// /api/show does ("vision", "tools"), so local image models can be offered
// for images like any other, and the check still proves them before saving.
async function describeOllama(conn, models) {
  const root = conn.baseUrl.replace(/\/v1$/, "");
  await Promise.all(models.slice(0, 50).map(async (m) => {
    try {
      const response = await fetch(root + "/api/show", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m.id }), signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) return;
      const abilities = (await response.json()).capabilities;
      if (!Array.isArray(abilities)) return;
      m.metadata = { ...m.metadata, input_modalities: abilities.includes("vision") ? ["text", "image"] : ["text"],
        supported_parameters: abilities.includes("tools") ? ["tools"] : [] };
    } catch { /* the model stays listed, its abilities unknown */ }
  }));
}
function responseText(response) { return (response?.content || []).filter(b => b.type === "text").map(b => b.text || "").join("\n"); }
// A connection opened ahead of a request, where opening one costs the reply
// time: NEAR AI's is proven first (near-private.js). For a provider whose
// connections cost nothing to open it does nothing. Never throws.
async function warm(conn, model) {
  try {
    if (conn.backend === "custom" && require("./near-private").isNear(conn)) await require("./near-private").warm(conn, model);
  } catch (e) { /* the request proves its own connection */ }
}

module.exports = { onRequest, responseText, request, stallWatch, warm, listModels, limitsFrom, waitAsked, looksLikeKey, appHeaders, hideKeys, KEY_AS_MODEL, convertToolToOpenAI, convertMessagesToOpenAI, convertResponseFromOpenAI, convertToolToGemini, convertMessagesToGemini, convertResponseFromGemini };
