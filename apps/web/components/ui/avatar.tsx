'use client';

import * as React from 'react';
import { cn, initials } from '@/lib/utils';

export interface AvatarProps {
  name: string;
  /** Optional image. Falls back to initials — never to a generic silhouette,
   *  which carries no information in a roster. */
  src?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Tints the ring in the organization's colour. */
  ringColor?: string;
  className?: string;
}

const sizes = {
  xs: 'size-5 text-[9px]',
  sm: 'size-6 text-2xs',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const;

export function Avatar({ name, src, size = 'md', ringColor, className }: AvatarProps) {
  const [failed, setFailed] = React.useState(false);
  const showImage = src && !failed;

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden',
        'rounded-xs bg-hover font-medium text-text-secondary',
        ringColor && 'ring-1',
        sizes[size],
        className,
      )}
      style={ringColor ? { '--tw-ring-color': ringColor } as React.CSSProperties : undefined}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden>{initials(name)}</span>
      )}
      <span className="sr-only">{name}</span>
    </span>
  );
}
