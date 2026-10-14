import type { AnchorHTMLAttributes, PropsWithChildren } from "react";
import { useNavigate } from "react-router-dom";

/**
 * next/link → react-router 兼容 shim。
 *
 * 由 vite.resolve.alias 与 tsconfig paths 双解析（搬迁面零改源）。
 * 点击拦截与 Next Link 语义对齐：修饰键 / 中键 / target=_blank 走浏览器默认行为。
 */
export default function NexLink({
  href,
  children,
  onClick,
  ...props
}: PropsWithChildren<AnchorHTMLAttributes<HTMLAnchorElement> & { readonly href: string }>) {
  const navigate = useNavigate();
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const fullHref = href.startsWith("/") ? `${base}${href}` : href;

  return (
    <a
      {...props}
      href={fullHref}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.target === "_blank"
        ) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
