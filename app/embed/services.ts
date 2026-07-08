import type { ComponentType } from 'react';
import {
  IconBed,
  IconClipboardCheck,
  IconHome,
  IconPaw,
  IconSun,
  type IconProps,
} from '../shared-ui/icons';

/** Display icons for the widget's service cards, keyed by the config service `icon` field. */
export const SERVICE_ICONS: Record<string, ComponentType<IconProps>> = {
  bed: IconBed,
  home: IconHome,
  sun: IconSun,
  paw: IconPaw,
  clipboard: IconClipboardCheck,
};
