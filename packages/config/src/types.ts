/** VRover unified configuration. */
export interface VroverConfig {
  llm: LlmSection;
  scout: ScoutSection;
  agent: AgentSection;
}

export interface LlmSection {
  /** Which provider to use. */
  provider: 'glm' | 'openai' | 'vllm' | 'custom' | 'anthropic';
  anthropic: AnthropicConfig;
  glm: GlmConfig;
  openai: OpenAiConfig;
  vllm: VllmConfig;
  custom: CustomConfig;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
}

export interface GlmConfig {
  apiKey: string;
  baseUrl: string;
  visionModel: string;
}

export interface OpenAiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface VllmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface CustomConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ScoutSection {
  host: string;
  port: number;
}

export interface AgentSection {
  maxSteps: number;
  /** Path to icon_detect.onnx */
  yoloPath: string;
  /** YOLO detection confidence threshold. */
  boxThreshold: number;
  /** NMS IoU threshold. */
  iouThreshold: number;
}
