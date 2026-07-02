import type { ComponentType } from 'react';
import {
  IconBed,
  IconClipboardCheck,
  IconHome,
  IconPaw,
  IconSun,
  type IconProps,
} from '../shared-ui/icons';

/** Display icons for the widget's service cards, keyed by the config service `type`. */
export const SERVICE_ICONS: Record<string, ComponentType<IconProps>> = {
  boarding: IconBed,
  housesitting: IconHome,
  daycare: IconSun,
  walk: IconPaw,
  checkin: IconClipboardCheck,
};
