import { Agent, PricingConfig, WorkspaceZone } from '../types/agent';

export interface RoomZone {
  id: WorkspaceZone | 'reception' | 'lounge';
  name: string;
  gridX: number; // Top-left tile X in 2.5D rectangular grid
  gridY: number; // Top-left tile Y in 2.5D rectangular grid
  width: number; // width in tiles
  height: number; // height in tiles
  color: string;
  floorPattern: 'wood' | 'tile' | 'carpet' | 'concrete' | 'executive' | 'terrazzo';
}

export interface FurnitureItem {
  id: string;
  name: string;
  type:
    | 'desk'
    | 'chair'
    | 'meeting_table'
    | 'whiteboard'
    | 'screen'
    | 'server_rack'
    | 'bookshelf'
    | 'plant'
    | 'coffee_machine'
    | 'water_cooler'
    | 'sofa'
    | 'kitchen_counter'
    | 'fridge'
    | 'snack_table'
    | 'reception_desk'
    | 'elevator'
    | 'hvac'
    | 'kanban'
    | 'lamp'
    | 'credenza'
    | 'terminal_podium'
    | 'device_bench';
  gridX: number;
  gridY: number;
  width?: number; // size in tiles
  height?: number;
  rotation?: number;
  label?: string;
  assignedAgentId?: string;
  interactiveZone?: WorkspaceZone | 'reception' | 'lounge';
  plantType?: 'monstera' | 'snake' | 'palm' | 'fig' | 'succulent' | 'bamboo';
  deskStyle?: 'boss' | 'standing' | 'research' | 'dev_rgb' | 'dev_figma' | 'qa_lab' | 'sec_console' | 'hotdesk' | 'sysadmin';
  subType?: string;
  statusColor?: string;
  scale?: number;
}

// 2.5D Rectangular Architectural Grid Dimensions (Screen-aligned, NO diamond/rombo!)
export const GRID_COLS = 24;
export const GRID_ROWS = 16;
export const GRID_WIDTH = GRID_COLS;
export const GRID_HEIGHT = GRID_ROWS;
export const TILE_SIZE = 48; // 48px square tile

/**
 * Rotates grid coordinates (gx, gy) by 90-degree steps (0, 1, 2, 3)
 * 0: 0° (Standard Horizontal Rectangular View)
 * 1: 90° Clockwise
 * 2: 180°
 * 3: 270° Counter-Clockwise
 */
export function rotateGrid(gx: number, gy: number, rotation = 0): { rx: number; ry: number } {
  const rot = ((rotation % 4) + 4) % 4;
  if (rot === 0) return { rx: gx, ry: gy };
  if (rot === 1) return { rx: GRID_ROWS - 1 - gy, ry: gx };
  if (rot === 2) return { rx: GRID_COLS - 1 - gx, ry: GRID_ROWS - 1 - gy };
  // rot === 3
  return { rx: gy, ry: GRID_COLS - 1 - gx };
}

export function unrotateGrid(rx: number, ry: number, rotation = 0): { gx: number; gy: number } {
  const rot = ((rotation % 4) + 4) % 4;
  if (rot === 0) return { gx: rx, gy: ry };
  if (rot === 1) return { gx: ry, gy: GRID_ROWS - 1 - rx };
  if (rot === 2) return { gx: GRID_COLS - 1 - rx, gy: GRID_ROWS - 1 - ry };
  // rot === 3
  return { gx: GRID_COLS - 1 - ry, gy: rx };
}

// Screen-aligned 2.5D projection (clean rectangular coordinates)
export function gridToScreen(gx: number, gy: number, rotation = 0): { x: number; y: number } {
  const { rx, ry } = rotateGrid(gx, gy, rotation);
  return {
    x: rx * TILE_SIZE,
    y: ry * TILE_SIZE,
  };
}

export function screenToGrid(x: number, y: number, rotation = 0): { gx: number; gy: number } {
  const rx = Math.floor(x / TILE_SIZE);
  const ry = Math.floor(y / TILE_SIZE);
  return unrotateGrid(rx, ry, rotation);
}

// 9 Defined Architectural Office Rooms forming a clean rectangular complex
export const OFFICE_ROOMS: RoomZone[] = [
  // --- ROW 1 (Top Suites, gy: 0..5, height: 6) ---
  {
    id: 'boss_office',
    name: 'Executive Director Suite',
    gridX: 0,
    gridY: 0,
    width: 7,
    height: 6,
    color: '#1e1b4b',
    floorPattern: 'executive',
  },
  {
    id: 'meeting_room',
    name: 'Meeting Room A',
    gridX: 7,
    gridY: 0,
    width: 5,
    height: 6,
    color: '#0f172a',
    floorPattern: 'carpet',
  },
  {
    id: 'meeting_room_b',
    name: 'Meeting Room B',
    gridX: 12,
    gridY: 0,
    width: 5,
    height: 6,
    color: '#111827',
    floorPattern: 'carpet',
  },
  {
    id: 'server_room',
    name: 'Model Ops & Token Operations Center',
    gridX: 17,
    gridY: 0,
    width: 7,
    height: 6,
    color: '#090d16',
    floorPattern: 'concrete',
  },

  // --- ROW 2 (Central Pods, gy: 7..11, height: 5) ---
  {
    id: 'leads_area',
    name: 'Architecture & Leads',
    gridX: 0,
    gridY: 7,
    width: 6,
    height: 5,
    color: '#111827',
    floorPattern: 'wood',
  },
  {
    id: 'development',
    name: 'Engineering & Dev Pods',
    gridX: 6,
    gridY: 7,
    width: 12,
    height: 5,
    color: '#0f172a',
    floorPattern: 'tile',
  },
  {
    id: 'qa_lab',
    name: 'QA & Test Automation Lab',
    gridX: 18,
    gridY: 7,
    width: 6,
    height: 5,
    color: '#131b2e',
    floorPattern: 'tile',
  },

  // --- ROW 3 (Amenities & Research, gy: 13..15, height: 3) ---
  {
    id: 'research_area',
    name: 'RAG Archives & Library',
    gridX: 0,
    gridY: 13,
    width: 7,
    height: 3,
    color: '#1a1d20',
    floorPattern: 'wood',
  },
  {
    id: 'break_room',
    name: 'Cafeteria & Espresso Bar',
    gridX: 7,
    gridY: 13,
    width: 10,
    height: 3,
    color: '#18181b',
    floorPattern: 'tile',
  },
  {
    id: 'lounge',
    name: 'Team Lounge & Relaxation',
    gridX: 17,
    gridY: 13,
    width: 7,
    height: 3,
    color: '#1e1e24',
    floorPattern: 'carpet',
  },
];

export interface HallwaySegment {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  width: number;
  height: number;
}

// Interconnecting architectural corridors connecting every zone
export const OFFICE_HALLWAYS: HallwaySegment[] = [
  // Upper Concourse (running horizontally between Northern Suites and Central Pods)
  { id: 'h_upper_ew', name: 'Upper Concourse', gridX: 0, gridY: 6, width: 24, height: 1 },
  // Lower Concourse (running horizontally between Central Pods and Amenities/Library)
  { id: 'h_lower_ew', name: 'Lower Concourse', gridX: 0, gridY: 12, width: 24, height: 1 },
];

export interface OfficeRenderedBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/**
 * Calculates the exact 2D rectangular screen bounding box of the entire office
 * taking 90° rotation into account.
 */
export function getOfficeRenderedBounds(rotation = 0): OfficeRenderedBounds {
  const rot = ((rotation % 4) + 4) % 4;
  const isRotated90 = rot === 1 || rot === 3;

  const cols = isRotated90 ? GRID_ROWS : GRID_COLS;
  const rows = isRotated90 ? GRID_COLS : GRID_ROWS;

  const width = cols * TILE_SIZE;
  const height = rows * TILE_SIZE;

  return {
    minX: 0,
    maxX: width,
    minY: 0,
    maxY: height,
    width,
    height,
    centerX: width / 2,
    centerY: height / 2,
  };
}

export const OFFICE_FURNITURE: FurnitureItem[] = [
  // Warm pools of light and a few perimeter accents keep circulation paths clear.
  { id: 'f_boss_lamp', name: 'Director Reading Lamp', type: 'lamp', gridX: 0, gridY: 4 },
  { id: 'f_boardroom_lamp', name: 'Boardroom Corner Lamp', type: 'lamp', gridX: 16, gridY: 1 },
  { id: 'f_leads_lamp', name: 'Architecture Reading Lamp', type: 'lamp', gridX: 5, gridY: 7 },
  { id: 'f_dev_lamp', name: 'Engineering Floor Lamp', type: 'lamp', gridX: 17, gridY: 10 },
  { id: 'f_qa_lamp', name: 'Lab Task Lamp', type: 'lamp', gridX: 23, gridY: 10 },
  { id: 'f_library_lamp', name: 'Library Reading Lamp', type: 'lamp', gridX: 3, gridY: 15 },
  { id: 'f_cafe_lamp', name: 'Cafe Ambient Lamp', type: 'lamp', gridX: 15, gridY: 13 },
  { id: 'f_lounge_lamp', name: 'Lounge Reading Lamp', type: 'lamp', gridX: 18, gridY: 15 },
  { id: 'f_dev_planter', name: 'Engineering Desk Planter', type: 'plant', gridX: 10, gridY: 8, plantType: 'succulent' },
  { id: 'f_qa_snake', name: 'Lab Corner Snake Plant', type: 'plant', gridX: 23, gridY: 7, plantType: 'snake' },
  // --- 1. EXECUTIVE DIRECTOR SUITE (gx: 0..6, gy: 0..5) ---
  { id: 'f_boss_desk', name: 'Executive Walnut L-Desk', type: 'desk', gridX: 3, gridY: 2, label: 'Director Desk', assignedAgentId: 'boss', deskStyle: 'boss', scale: 1.65 },
  { id: 'f_boss_chair', name: 'Leather Executive High-Back Chair', type: 'chair', gridX: 3, gridY: 1, subType: 'executive' },
  { id: 'f_boss_credenza', name: 'Mahogany Bookshelf & Awards Credenza', type: 'credenza', gridX: 5, gridY: 1 },
  { id: 'f_boss_screen', name: 'Wall KPI Dashboard Display', type: 'screen', gridX: 1, gridY: 1, label: 'Objectives Wall' },
  { id: 'f_boss_vis_table', name: 'VIP Discussion Table', type: 'desk', gridX: 1, gridY: 4, deskStyle: 'hotdesk' },
  { id: 'f_boss_vis_1', name: 'VIP Guest Armchair 1', type: 'chair', gridX: 1, gridY: 3, subType: 'armchair' },
  { id: 'f_boss_vis_2', name: 'VIP Guest Armchair 2', type: 'chair', gridX: 2, gridY: 4, subType: 'armchair' },
  { id: 'f_boss_fig', name: 'Large Fiddle Leaf Fig', type: 'plant', gridX: 5, gridY: 4, plantType: 'fig' },
  { id: 'f_boss_succulent', name: 'Desk Bonsai & Lamp', type: 'plant', gridX: 4, gridY: 2, plantType: 'succulent' },

  // --- 2. CONFERENCE BOARDROOM (gx: 7..16, gy: 0..5) ---
  { id: 'f_conf_table', name: 'Meeting Room A Table', type: 'meeting_table', gridX: 9, gridY: 2 },
  { id: 'f_conf_whiteboard', name: 'Glass Flowchart Architecture Board', type: 'whiteboard', gridX: 8, gridY: 2 },
  { id: 'f_conf_chair_1', name: 'Board Chair West', type: 'chair', gridX: 9, gridY: 2 },
  { id: 'f_conf_chair_2', name: 'Board Chair North 1', type: 'chair', gridX: 10, gridY: 1 },
  { id: 'f_conf_chair_3', name: 'Board Chair North 2', type: 'chair', gridX: 11, gridY: 1 },
  { id: 'f_conf_chair_4', name: 'Room A Chair East', type: 'chair', gridX: 10, gridY: 2 },
  { id: 'f_conf_chair_5', name: 'Room A Chair South 1', type: 'chair', gridX: 8, gridY: 3 },
  { id: 'f_conf_chair_6', name: 'Room A Chair South 2', type: 'chair', gridX: 10, gridY: 3 },
  { id: 'f_conf_chair_7', name: 'Meeting Room B Table', type: 'meeting_table', gridX: 14, gridY: 2 },
  { id: 'f_conf_b_chair_1', name: 'Room B Chair West', type: 'chair', gridX: 13, gridY: 2 },
  { id: 'f_conf_b_chair_2', name: 'Room B Chair East', type: 'chair', gridX: 15, gridY: 2 },
  { id: 'f_conf_b_chair_3', name: 'Room B Chair South West', type: 'chair', gridX: 13, gridY: 3 },
  { id: 'f_conf_b_chair_4', name: 'Room B Chair South East', type: 'chair', gridX: 15, gridY: 3 },
  { id: 'f_conf_credenza', name: 'Side Conference Credenza & Tablets', type: 'credenza', gridX: 15, gridY: 1 },
  { id: 'f_conf_plant_1', name: 'Boardroom Monstera', type: 'plant', gridX: 7, gridY: 1, plantType: 'monstera' },
  { id: 'f_conf_plant_2', name: 'Tall Architectural Snake Plant', type: 'plant', gridX: 16, gridY: 4, plantType: 'snake' },

  // --- 3. CLOUD & INFRASTRUCTURE VAULT (gx: 17..23, gy: 0..5) ---
  { id: 'f_server_rack_1', name: 'OpenAI Provider Node', type: 'server_rack', gridX: 18, gridY: 1, label: 'OpenAI · Tokens' },
  { id: 'f_server_rack_2', name: 'Anthropic Provider Node', type: 'server_rack', gridX: 20, gridY: 1, label: 'Anthropic · Tokens' },
  { id: 'f_server_rack_3', name: 'Google Gemini Provider Node', type: 'server_rack', gridX: 22, gridY: 1, label: 'Gemini · Tokens' },
  { id: 'f_server_rack_4', name: 'Local Model Runtime Rack', type: 'server_rack', gridX: 22, gridY: 3, label: 'Local · Requests' },
  { id: 'f_server_noc', name: 'Live Model Usage Display', type: 'screen', gridX: 20, gridY: 0, label: 'LIVE TOKEN FLOW' },
  { id: 'f_server_hvac', name: 'Precision Air Cooling HVAC', type: 'hvac', gridX: 18, gridY: 0 },
  { id: 'f_server_desk', name: 'Token Telemetry Workstation', type: 'desk', gridX: 18, gridY: 4, label: 'Token Telemetry', deskStyle: 'sysadmin' },
  { id: 'f_server_chair', name: 'Technical Operator Chair', type: 'chair', gridX: 18, gridY: 3 },

  // --- 4. ARCHITECTURE & LEADS (gx: 0..5, gy: 7..11) ---
  { id: 'f_tech_lead_desk', name: 'Tech Lead Standing Desk', type: 'desk', gridX: 2, gridY: 8, label: 'Alex (Tech Lead)', assignedAgentId: 'tech-lead', deskStyle: 'standing' },
  { id: 'f_tech_lead_chair', name: 'Ergonomic Mesh Chair', type: 'chair', gridX: 2, gridY: 7 },
  { id: 'f_research_lead_desk', name: 'Research Lead Lab Desk', type: 'desk', gridX: 4, gridY: 8, label: 'Dr. Maya (Research)', assignedAgentId: 'research-lead', deskStyle: 'research' },
  { id: 'f_research_lead_chair', name: 'Ergonomic Task Chair', type: 'chair', gridX: 4, gridY: 7 },
  { id: 'f_leads_whiteboard', name: 'System Blueprint Flowchart Board', type: 'whiteboard', gridX: 1, gridY: 10 },
  { id: 'f_leads_bookcase', name: 'Technical RFC Bookcase', type: 'bookshelf', gridX: 0, gridY: 8 },
  { id: 'f_leads_table', name: 'Quick Huddle Round Table', type: 'desk', gridX: 3, gridY: 10, deskStyle: 'hotdesk' },
  { id: 'f_leads_stool_1', name: 'Huddle Stool West', type: 'chair', gridX: 2, gridY: 10, subType: 'stool' },
  { id: 'f_leads_stool_2', name: 'Huddle Stool East', type: 'chair', gridX: 4, gridY: 10, subType: 'stool' },
  { id: 'f_leads_bamboo', name: 'Bamboo Acoustic Partition', type: 'plant', gridX: 0, gridY: 9, plantType: 'bamboo' },
  { id: 'f_leads_monstera', name: 'Potted Monstera', type: 'plant', gridX: 5, gridY: 10, plantType: 'monstera' },

  // --- 5. DEV & ENGINEERING PODS (gx: 6..17, gy: 7..11) ---
  { id: 'f_backend_desk', name: 'Backend Engineering Station', type: 'desk', gridX: 8, gridY: 9, label: 'Elena (Backend)', assignedAgentId: 'backend-agent', deskStyle: 'dev_rgb' },
  { id: 'f_backend_chair', name: 'Pro Gaming Ergonomic Chair', type: 'chair', gridX: 8, gridY: 8 },
  { id: 'f_frontend_desk', name: 'Frontend Design & UI Station', type: 'desk', gridX: 12, gridY: 9, label: 'Kenji (Frontend)', assignedAgentId: 'frontend-agent', deskStyle: 'dev_figma' },
  { id: 'f_frontend_chair', name: 'Minimalist White Chair', type: 'chair', gridX: 12, gridY: 8 },
  { id: 'f_sec_desk', name: 'Security Pod Console', type: 'desk', gridX: 15, gridY: 9, label: 'Marcus (Security)', assignedAgentId: 'security-agent', deskStyle: 'sec_console' },
  { id: 'f_sec_chair', name: 'High-Back Tech Chair', type: 'chair', gridX: 15, gridY: 8 },
  { id: 'f_dev_kanban', name: 'Wall Sprint Kanban Board', type: 'kanban', gridX: 9, gridY: 7 },
  { id: 'f_dev_dock', name: 'Mini Dev Server Tower & Dock', type: 'device_bench', gridX: 16, gridY: 8 },
  { id: 'f_dev_collab', name: 'Code Review Sync Bench', type: 'desk', gridX: 11, gridY: 11, deskStyle: 'hotdesk' },
  { id: 'f_dev_palm', name: 'Kentia Palm', type: 'plant', gridX: 6, gridY: 9, plantType: 'palm' },
  { id: 'f_dev_snake_1', name: 'Snake Plant Planter', type: 'plant', gridX: 17, gridY: 9, plantType: 'snake' },

  // --- 6. QA AUTOMATION LAB (gx: 18..23, gy: 7..11) ---
  { id: 'f_qa_bench', name: 'Heavy QA Diagnostic Bench', type: 'desk', gridX: 20, gridY: 9, label: 'Zoe (QA Lead)', assignedAgentId: 'qa-agent', deskStyle: 'qa_lab' },
  { id: 'f_qa_chair', name: 'Heavy-Duty Lab Chair', type: 'chair', gridX: 20, gridY: 8 },
  { id: 'f_qa_screen', name: 'Automated CI/CD Pipeline Monitor', type: 'screen', gridX: 22, gridY: 7, label: 'CI/CD Pipeline' },
  { id: 'f_qa_devices', name: 'Multi-Device Test Matrix Dock', type: 'device_bench', gridX: 22, gridY: 9 },
  { id: 'f_qa_whiteboard', name: 'Bug Triage & Defect Board', type: 'whiteboard', gridX: 19, gridY: 7 },
  { id: 'f_qa_plant', name: 'Potted Pothos', type: 'plant', gridX: 18, gridY: 10, plantType: 'succulent' },

  // --- 7. RESEARCH & RAG LIBRARY (gx: 0..6, gy: 13..15) ---
  { id: 'f_bookshelf_1', name: 'RFC Technical Library 1', type: 'bookshelf', gridX: 0, gridY: 15 },
  { id: 'f_bookshelf_2', name: 'AI Index Archive 2', type: 'bookshelf', gridX: 1, gridY: 15 },
  { id: 'f_bookshelf_3', name: 'Knowledge Graph Reference 3', type: 'bookshelf', gridX: 2, gridY: 15 },
  { id: 'f_research_table', name: 'Study & Document Reading Table', type: 'desk', gridX: 4, gridY: 14, label: 'Study Table', deskStyle: 'research' },
  { id: 'f_library_chair', name: 'Armchair Reader', type: 'chair', gridX: 4, gridY: 13, subType: 'armchair' },
  { id: 'f_library_terminal', name: 'Vector Search Terminal Podium', type: 'terminal_podium', gridX: 6, gridY: 13 },
  { id: 'f_library_fig', name: 'Corner Weeping Fig', type: 'plant', gridX: 6, gridY: 15, plantType: 'fig' },

  // --- 8. CAFETERIA & ESPRESSO BAR (gx: 7..16, gy: 13..15) ---
  { id: 'f_fridge', name: 'Stainless Steel Double Fridge', type: 'fridge', gridX: 7, gridY: 13 },
  { id: 'f_water', name: 'Spring Water Cooler', type: 'water_cooler', gridX: 7, gridY: 14 },
  { id: 'f_kitchen_counter', name: 'Kitchen Counter with Sink', type: 'kitchen_counter', gridX: 8, gridY: 13 },
  { id: 'f_espresso', name: 'Italian Espresso Machine & Bar', type: 'coffee_machine', gridX: 9, gridY: 13 },
  { id: 'f_cafe_stool_1', name: 'Bar Stool 1', type: 'chair', gridX: 8, gridY: 14, subType: 'stool' },
  { id: 'f_cafe_stool_2', name: 'Bar Stool 2', type: 'chair', gridX: 9, gridY: 14, subType: 'stool' },
  { id: 'f_cafe_stool_3', name: 'Bar Stool 3', type: 'chair', gridX: 10, gridY: 14, subType: 'stool' },
  { id: 'f_coffee_table_a', name: 'Coffee Table A', type: 'meeting_table', subType: 'cafe_round', gridX: 11.6, gridY: 13.8, label: 'Table A' },
  { id: 'f_coffee_table_b', name: 'Coffee Table B', type: 'meeting_table', subType: 'cafe_round', gridX: 15.2, gridY: 13.8, label: 'Table B' },
  { id: 'f_cafe_plant', name: 'Lush Monstera', type: 'plant', gridX: 16.5, gridY: 15, plantType: 'monstera' },

  // --- 9. TEAM RELAXATION LOUNGE (gx: 17..23, gy: 13..15) ---
  { id: 'f_sofa_1', name: 'Teal Modern Sectional Sofa', type: 'sofa', gridX: 19, gridY: 14 },
  { id: 'f_sofa_2', name: 'Sectional Loveseat Extension', type: 'sofa', gridX: 20, gridY: 14 },
  { id: 'f_lounge_table', name: 'Round Oak Coffee Table', type: 'desk', gridX: 19, gridY: 15, deskStyle: 'hotdesk' },
  { id: 'f_lounge_screen', name: 'Wall Relaxation & Ambient Screen', type: 'screen', gridX: 21, gridY: 13, label: 'Lounge Display' },
  { id: 'f_lounge_pouf', name: 'Brainstorming Floor Pouf', type: 'chair', gridX: 22, gridY: 14, subType: 'stool' },
  { id: 'f_lounge_palm', name: 'Majesty Palm', type: 'plant', gridX: 23, gridY: 13, plantType: 'palm' },
  { id: 'f_lounge_snake', name: 'Cylinder Snake Plant', type: 'plant', gridX: 17, gridY: 14, plantType: 'snake' },
];

export const INITIAL_AGENTS: Agent[] = [
  {
    id: 'boss',
    name: 'Director (Boss Agent)',
    role: 'boss',
    roleTitle: 'Chief Orchestrator & Executive',
    team: 'leadership',
    managerId: null,
    provider: 'OpenAI',
    model: 'gpt-4o',
    status: 'IDLE',
    statusText: 'Monitoring company objectives',
    currentTaskId: null,
    currentTool: null,
    workspace: 'boss_office',
    x: 3,
    y: 3,
    targetX: 3,
    targetY: 3,
    isWalking: false,
    facing: 'SE',
    avatarColor: '#6366f1',
    clothingColor: '#312e81',
    hairColor: '#e2e8f0',
    accessory: 'tie',
    tokensInput: 14200,
    tokensOutput: 3100,
    cachedTokens: 8400,
    reasoningTokens: 1200,
    cost: 0.082,
    startedAt: Date.now() - 1000 * 60 * 45,
    speechBubble: null,
  },
  {
    id: 'tech-lead',
    name: 'Alex Rivera',
    role: 'tech_lead',
    roleTitle: 'Tech Lead & Architect',
    team: 'leadership',
    managerId: 'boss',
    provider: 'Anthropic',
    model: 'claude-3-7-sonnet',
    status: 'IDLE',
    statusText: 'Reviewing architecture blueprints',
    currentTaskId: null,
    currentTool: null,
    workspace: 'leads_area',
    x: 2,
    y: 9,
    targetX: 2,
    targetY: 9,
    isWalking: false,
    facing: 'SE',
    avatarColor: '#0ea5e9',
    clothingColor: '#0369a1',
    hairColor: '#78350f',
    accessory: 'hoodie',
    tokensInput: 28400,
    tokensOutput: 6800,
    cachedTokens: 16000,
    reasoningTokens: 3400,
    cost: 0.185,
    startedAt: Date.now() - 1000 * 60 * 40,
    speechBubble: null,
  },
  {
    id: 'research-lead',
    name: 'Dr. Maya Chen',
    role: 'research_lead',
    roleTitle: 'Research & Knowledge Lead',
    team: 'research',
    managerId: 'boss',
    provider: 'Google Gemini',
    model: 'gemini-2.5-pro',
    status: 'IDLE',
    statusText: 'Indexing scientific references',
    currentTaskId: null,
    currentTool: null,
    workspace: 'leads_area',
    x: 4,
    y: 9,
    targetX: 4,
    targetY: 9,
    isWalking: false,
    facing: 'SW',
    avatarColor: '#10b981',
    clothingColor: '#065f46',
    hairColor: '#1f2937',
    accessory: 'glasses',
    tokensInput: 34500,
    tokensOutput: 8900,
    cachedTokens: 19500,
    reasoningTokens: 4100,
    cost: 0.142,
    startedAt: Date.now() - 1000 * 60 * 35,
    speechBubble: null,
  },
  {
    id: 'backend-agent',
    name: 'Elena Rostova',
    role: 'backend_engineer',
    roleTitle: 'Senior Backend Engineer',
    team: 'engineering',
    managerId: 'tech-lead',
    provider: 'OpenAI',
    model: 'gpt-4o',
    status: 'IDLE',
    statusText: 'Ready for API development',
    currentTaskId: null,
    currentTool: null,
    workspace: 'development',
    x: 8,
    y: 10,
    targetX: 8,
    targetY: 10,
    isWalking: false,
    facing: 'NW',
    avatarColor: '#f59e0b',
    clothingColor: '#92400e',
    hairColor: '#dc2626',
    accessory: 'headphones',
    tokensInput: 46200,
    tokensOutput: 12300,
    cachedTokens: 28000,
    reasoningTokens: 5200,
    cost: 0.284,
    startedAt: Date.now() - 1000 * 60 * 30,
    speechBubble: null,
  },
  {
    id: 'frontend-agent',
    name: 'Kenji Sato',
    role: 'frontend_engineer',
    roleTitle: 'Senior UI/UX Engineer',
    team: 'engineering',
    managerId: 'tech-lead',
    provider: 'Anthropic',
    model: 'claude-3-5-sonnet',
    status: 'IDLE',
    statusText: 'Inspecting design tokens',
    currentTaskId: null,
    currentTool: null,
    workspace: 'development',
    x: 12,
    y: 10,
    targetX: 12,
    targetY: 10,
    isWalking: false,
    facing: 'NW',
    avatarColor: '#ec4899',
    clothingColor: '#9d174d',
    hairColor: '#1e1b4b',
    accessory: 'glasses',
    tokensInput: 22100,
    tokensOutput: 5100,
    cachedTokens: 12400,
    reasoningTokens: 1800,
    cost: 0.126,
    startedAt: Date.now() - 1000 * 60 * 25,
    speechBubble: null,
  },
  {
    id: 'qa-agent',
    name: 'Zoe Vance',
    role: 'qa_engineer',
    roleTitle: 'QA & Automated Testing Lead',
    team: 'quality',
    managerId: 'tech-lead',
    provider: 'OpenAI',
    model: 'gpt-4o-mini',
    status: 'IDLE',
    statusText: 'End-to-end regression suites idle',
    currentTaskId: null,
    currentTool: null,
    workspace: 'qa_lab',
    x: 20,
    y: 10,
    targetX: 20,
    targetY: 10,
    isWalking: false,
    facing: 'NE',
    avatarColor: '#8b5cf6',
    clothingColor: '#5b21b6',
    hairColor: '#eab308',
    accessory: 'badge',
    tokensInput: 18900,
    tokensOutput: 4200,
    cachedTokens: 9800,
    reasoningTokens: 900,
    cost: 0.038,
    startedAt: Date.now() - 1000 * 60 * 20,
    speechBubble: null,
  },
  {
    id: 'security-agent',
    name: 'Marcus Brody',
    role: 'security_analyst',
    roleTitle: 'Security & Compliance Auditor',
    team: 'engineering',
    managerId: 'tech-lead',
    provider: 'Google Gemini',
    model: 'gemini-2.5-flash',
    status: 'IDLE',
    statusText: 'Monitoring telemetry & secrets',
    currentTaskId: null,
    currentTool: null,
    workspace: 'development',
    x: 15,
    y: 10,
    targetX: 15,
    targetY: 10,
    isWalking: false,
    facing: 'NW',
    avatarColor: '#14b8a6',
    clothingColor: '#0f766e',
    hairColor: '#374151',
    accessory: 'badge',
    tokensInput: 15400,
    tokensOutput: 2900,
    cachedTokens: 8100,
    reasoningTokens: 600,
    cost: 0.024,
    startedAt: Date.now() - 1000 * 60 * 15,
    speechBubble: null,
  },
];

export const DEFAULT_PRICING: PricingConfig[] = [
  { provider: 'OpenAI', model: 'gpt-4o', inputPerMillion: 2.5, outputPerMillion: 10.0, cachedPerMillion: 1.25 },
  { provider: 'OpenAI', model: 'gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6, cachedPerMillion: 0.075 },
  { provider: 'Anthropic', model: 'claude-3-7-sonnet', inputPerMillion: 3.0, outputPerMillion: 15.0, cachedPerMillion: 0.3 },
  { provider: 'Anthropic', model: 'claude-3-5-sonnet', inputPerMillion: 3.0, outputPerMillion: 15.0, cachedPerMillion: 0.3 },
  { provider: 'Google Gemini', model: 'gemini-2.5-pro', inputPerMillion: 1.25, outputPerMillion: 5.0, cachedPerMillion: 0.3 },
  { provider: 'Google Gemini', model: 'gemini-2.5-flash', inputPerMillion: 0.075, outputPerMillion: 0.3, cachedPerMillion: 0.02 },
  { provider: 'Local (Ollama)', model: 'llama-3.3-70b', inputPerMillion: 0.0, outputPerMillion: 0.0, cachedPerMillion: 0.0 },
];
