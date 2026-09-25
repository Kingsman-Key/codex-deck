const DEEPSEEK_BASE_INSTRUCTIONS = [
  "You are a coding agent running inside Codex Deck.",
  "Work collaboratively with the user in the current workspace.",
  "Follow applicable AGENTS.md instructions, preserve unrelated user changes, and never expose secrets.",
  "Inspect the relevant files before editing, verify material changes, and report results concisely.",
].join(" ");

const REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "high", description: "Deeper reasoning for complex problems" },
  { effort: "max", description: "Maximum reasoning for the hardest problems" },
];

function modelMessages() {
  return {
    instructions_template: DEEPSEEK_BASE_INSTRUCTIONS,
    instructions_variables: null,
    approvals: null,
    collaboration_modes: null,
    auto_review: null,
    permissions: null,
    multi_agent: null,
  };
}

function deepSeekModel(options: {
  slug: "deepseek-flash" | "deepseek-v4-pro";
  displayName: string;
  description: string;
  inputModalities: Array<"text" | "image">;
  supportsImageDetailOriginal: boolean;
  supportsSearchTool: boolean;
  priority: number;
}) {
  return {
    slug: options.slug,
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    input_modalities: options.inputModalities,
    supports_image_detail_original: options.supportsImageDetailOriginal,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    tool_mode: null,
    multi_agent_version: "v2",
    use_responses_lite: false,
    include_skills_usage_instructions: false,
    auto_review_model_override: null,
    context_window: 1_048_576,
    max_context_window: 1_048_576,
    effective_context_window_percent: 95,
    auto_compact_token_limit: null,
    comp_hash: "3000",
    reasoning_summary_format: "experimental",
    default_reasoning_summary: "none",
    display_name: options.displayName,
    description: options.description,
    default_reasoning_level: "high",
    supported_reasoning_levels: REASONING_LEVELS,
    shell_type: "shell_command",
    visibility: "list",
    minimal_client_version: "0.144.0",
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority: options.priority,
    supports_search_tool: options.supportsSearchTool,
    default_service_tier: null,
    supports_reasoning_summaries: true,
    model_messages: modelMessages(),
    base_instructions: DEEPSEEK_BASE_INSTRUCTIONS,
  };
}

export const DEEPSEEK_MODEL_CATALOG_FILENAME = "deepseek-models.json";

export function createDeepSeekModelCatalog() {
  return {
    models: [
      deepSeekModel({
        slug: "deepseek-flash",
        displayName: "DeepSeek-Flash",
        description: "Fast agentic coding model with image input.",
        inputModalities: ["text", "image"],
        supportsImageDetailOriginal: true,
        supportsSearchTool: true,
        priority: 1,
      }),
      deepSeekModel({
        slug: "deepseek-v4-pro",
        displayName: "DeepSeek-V4-Pro",
        description: "Most capable DeepSeek agentic coding model.",
        inputModalities: ["text"],
        supportsImageDetailOriginal: false,
        supportsSearchTool: false,
        priority: 2,
      }),
    ],
  };
}

export function serializeDeepSeekModelCatalog(): string {
  return `${JSON.stringify(createDeepSeekModelCatalog(), null, 2)}\n`;
}
