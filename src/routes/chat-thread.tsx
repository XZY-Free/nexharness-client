import { AuthGate } from "@/components/auth/auth-gate";
import { WebThreadShell } from "@/components/thread/web-thread-shell";
import { useParams } from "react-router-dom";
import { NotFoundView } from "./not-found";

// /chat/{threadId} 只接受真实会话 UUID；新建空态统一走 /chat。
// 登录门禁：AuthGate（客户端校验 /api/user/current，未登录跳 /login）。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ChatThreadRoute() {
  const { threadId } = useParams<{ threadId: string }>();
  if (!threadId || !UUID_PATTERN.test(threadId)) return <NotFoundView />;
  return (
    <AuthGate returnTo={`/chat/${threadId}`}>
      <WebThreadShell threadId={threadId} />
    </AuthGate>
  );
}
