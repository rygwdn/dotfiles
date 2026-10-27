import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-16 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm",
        "placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500",
        "disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700",
        className,
      )}
      {...props}
    />
  );
});
