import {
  Ambulance,
  ArrowRightLeft,
  Bell,
  Building2,
  Car,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleSlash,
  Clock,
  Construction,
  Crosshair,
  Dog,
  Flag,
  Flame,
  HeartPulse,
  IdCard,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Map,
  MapPin,
  Megaphone,
  MessageSquare,
  PauseCircle,
  PenLine,
  Pin,
  Plane,
  Radio,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Siren,
  Star,
  Swords,
  TriangleAlert,
  Truck,
  User,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * Renders a lucide icon by name.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AN EXPLICIT REGISTRY, NOT A NAMESPACE IMPORT
 *
 * Navigation, statuses, unit types and notification types are DATA — each names
 * its icon as a string so the catalogue stays serialisable and a status added to
 * the database can carry its own icon (engineering rules 5–7). That requires a
 * lookup from name to component, and the obvious way to write it is
 *
 *     import * as Icons from 'lucide-react';
 *     const Cmp = Icons[name];
 *
 * which is what this was. A namespace import is opaque to tree-shaking: the
 * bundler cannot know which members are read, so it keeps ALL of them. Measured:
 * that pulled the entire icon library — around 1 500 components — into the
 * shared client chunk, which was 948 KB, on every page including the sign-in
 * screen.
 *
 * The registry below is generated from the icon names the catalogues can
 * actually produce. It keeps the data-driven property exactly — the lookup is
 * still by string, at runtime — and lets the bundler drop everything else.
 *
 * ADDING AN ICON: name it in a catalogue and add it here. An unknown name
 * renders nothing rather than crashing, which is the same behaviour as before
 * and the right one for a client that meets a catalogue newer than itself.
 *  fails the build if a catalogue names one this file
 * does not have, so the two cannot drift silently.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const ICONS: Record<string, LucideIcon> = {
  Ambulance,
  ArrowRightLeft,
  Bell,
  Building2,
  Car,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleSlash,
  Clock,
  Construction,
  Crosshair,
  Dog,
  Flag,
  Flame,
  HeartPulse,
  IdCard,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Map,
  MapPin,
  Megaphone,
  MessageSquare,
  PauseCircle,
  PenLine,
  Pin,
  Plane,
  Radio,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Siren,
  Star,
  Swords,
  TriangleAlert,
  Truck,
  User,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
  Wrench,
};

export function Icon({ name, className }: { name: string; className?: string }) {
  const Cmp = ICONS[name];
  if (!Cmp) return null;
  return <Cmp className={className} aria-hidden />;
}
