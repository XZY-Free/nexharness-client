import "@/src/styles/globals.css";
import { BrandProvider } from "@/components/brand/brand-provider";
import { createRoot } from "react-dom/client";
import { ClientApp } from "./app";
import { exchangeTicketIfPresent } from "./lib/ticket-exchange";

async function boot(): Promise<void> {
  // 登录回跳先兑换票据（?ticket= → 会话 cookie），再渲染应用。
  await exchangeTicketIfPresent();
  const root = document.getElementById("root");
  if (!root) throw new Error("缺少 #root 节点");
  createRoot(root).render(
    <BrandProvider>
      <ClientApp />
    </BrandProvider>,
  );
}

void boot();
