import type { ComponentChildren } from 'preact';

export type Role = 'owner' | 'editor' | 'viewer';
export type Mode = 'live' | 'source' | 'read';

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  skin: 'graphite' | 'midnight' | 'paper';
  accent: string;
  uiFont: 'manrope' | 'system' | 'serif' | 'mono';
  textFont: 'manrope' | 'system' | 'serif' | 'mono';
  fontSize: number;
  lineWidth: number; // 0 — во всю ширину
  radius: number;
  motion: boolean;
  ripple: boolean;
  glass: boolean;
  ambient: boolean;
  defaultMode: Mode;
  lineNumbers: boolean;
  spellcheck: boolean;
  customCss: string;
}

export interface User { id: string; login: string; displayName: string; settings: Partial<Settings> }
export interface Vault { id: string; name: string; role: Role; ownerName: string; memberCount: number }
export interface Member { id: string; login: string; displayName: string; role: Role }

export interface TreeNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'folder' | 'file';
  binary: boolean;
  size: number;
  version: number;
  updatedAt: string;
}

export interface Presence { clientId: string; userId: string; name: string; nodeId: string | null }

export type MenuItem =
  | { sep: true }
  | { title: string }
  | {
    label: string;
    icon?: ComponentChildren;
    hint?: string;
    danger?: boolean;
    disabled?: boolean;
    checked?: boolean;
    onClick?: () => void;
    children?: MenuItem[];
  };
