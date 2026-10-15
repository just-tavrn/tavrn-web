// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, type ComponentType } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { LoginPage } from "./pages/LoginPage";
import { AppLayout } from "./pages/AppLayout";
import { HomePage } from "./pages/HomePage";
import { ChannelPage, RoomIndexRedirect } from "./pages/ChannelPage";
import { InvitePage } from "./pages/InvitePage";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/PasswordResetPages";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { EncryptionPage } from "./pages/EncryptionPage";
import { ConversationPage } from "./pages/DirectMessages";
import { FriendsPage } from "./pages/FriendsPage";
import { ConnectCallbackPage, ConnectPage } from "./pages/ConnectPages";
import { SsoCallbackPage } from "./pages/SsoCallbackPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { ProfilePage } from "./pages/ProfilePage";
import { MessageRequestPage, MessageRequestsPage } from "./pages/MessageRequestsPage";
import { ReauthDialog } from "./components/ReauthDialog";
import { DownloadWarningDialog } from "./components/DownloadWarningDialog";
import { ConfirmHost } from "./components/Confirm";
import { TermsGate } from "./components/legal/TermsGate";
import { DateOfBirthGate } from "./components/age/DateOfBirthGate";
import { NodePickerPage } from "./pages/NodePickerPage";
import { AndroidShell } from "./components/AndroidShell";
import { DeepLinkPrompt } from "./components/DeepLinkPrompt";
import { platform } from "./platform";

/** A route loaded on first use (its own chunk), shown without a placeholder while the chunk arrives. */
function lazyPage(load: () => Promise<ComponentType>) {
  const Page = lazy(() => load().then((c) => ({ default: c })));
  return (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  );
}

// Loaded only when opened: the whiteboard (and with it the Excalidraw canvas), and the rarely opened settings,
// administration, application and legal pages, so they are not part of the startup bundle.
const whiteboard = lazyPage(() => import("./whiteboard/WhiteboardPage").then((m) => m.WhiteboardPage));
const roomSettings = lazyPage(() => import("./pages/settings/RoomSettingsPage").then((m) => m.RoomSettingsPage));
const userSettings = lazyPage(() => import("./pages/UserSettingsPage").then((m) => m.UserSettingsPage));
const admin = lazyPage(() => import("./pages/AdminPage").then((m) => m.AdminPage));
const addApplication = lazyPage(() => import("./pages/AddApplicationPage").then((m) => m.AddApplicationPage));
const legal = () => import("./pages/legal/LegalPages");
const legalIndex = lazyPage(() => legal().then((m) => m.LegalIndexPage));
const legalNotice = lazyPage(() => legal().then((m) => m.NoticeFormPage));
const legalNoticeStatus = lazyPage(() => legal().then((m) => m.NoticeStatusPage));
const legalDocument = lazyPage(() => legal().then((m) => m.LegalDocumentPage));

export function App() {
  const desktop = platform().isDesktop;
  // The desktop app without a home node yet: the node picker for every path (docs/DESKTOP.md).
  if (desktop && !platform().node?.current()) {
    return (
      <BrowserRouter>
        <AndroidShell />
        <DeepLinkPrompt />
        <Routes>
          <Route path="*" element={<NodePickerPage />} />
        </Routes>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter>
      <AndroidShell />
      <DeepLinkPrompt />
      <Routes>
        {/* Desktop app: change the home node (Settings → App). */}
        {desktop && <Route path="/node" element={<NodePickerPage />} />}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/encryption" element={<EncryptionPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        {/* The link of the confirmation mail (PROTOCOL.md §5a.3). */}
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/invite/:code" element={<InvitePage />} />
        {/* Add links of applications (APPLICATIONS.md §4.1), also of other nodes. */}
        <Route path="/add/:id" element={addApplication} />
        <Route path="/add/:domain/:id" element={addApplication} />
        {/* Sign-in with an account of this node on another node's web client (FEDERATION.md §8). */}
        <Route path="/connect" element={<ConnectPage />} />
        <Route path="/connect/callback" element={<ConnectCallbackPage />} />
        <Route path="/sso/callback" element={<SsoCallbackPage />} />
        {/* Legal pages, the notice form and its status page (design note 4.14); public. */}
        <Route path="/legal" element={legalIndex} />
        <Route path="/legal/notice" element={legalNotice} />
        <Route path="/legal/notice/:caseId" element={legalNoticeStatus} />
        <Route path="/legal/:kind" element={legalDocument} />
        <Route path="/" element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="rooms/:roomId" element={<RoomIndexRedirect />} />
          {/* The thread panel is part of the channel page (it stays mounted while threads open and close). */}
          <Route path="rooms/:roomId/channels/:channelId" element={<ChannelPage />}>
            <Route path="threads/:threadId" element={null} />
          </Route>
          {/* The whiteboard of a conversation, full screen (design note 4.10). */}
          <Route path="rooms/:roomId/channels/:channelId/whiteboard" element={whiteboard} />
          <Route path="rooms/:roomId/settings/:tab?" element={roomSettings} />
          {/* Rooms of other nodes: ids are node-scoped (`<domain>/<ulid>`). */}
          <Route path="n/:node/rooms/:roomId" element={<RoomIndexRedirect />} />
          {/* The thread panel is part of the channel page (it stays mounted while threads open and close). */}
          <Route path="n/:node/rooms/:roomId/channels/:channelId" element={<ChannelPage />}>
            <Route path="threads/:threadId" element={null} />
          </Route>
          <Route path="n/:node/rooms/:roomId/channels/:channelId/whiteboard" element={whiteboard} />
          <Route path="n/:node/rooms/:roomId/settings/:tab?" element={roomSettings} />
          <Route path="conversations/:conversationId" element={<ConversationPage />} />
          <Route path="conversations/:conversationId/whiteboard" element={whiteboard} />
          {/* DMs and group DMs hosted on another node (the initiator's home node, FEDERATION.md §6.1). */}
          <Route path="n/:node/conversations/:conversationId" element={<ConversationPage />} />
          <Route path="n/:node/conversations/:conversationId/whiteboard" element={whiteboard} />
          <Route path="friends" element={<FriendsPage />} />
          <Route path="requests" element={<MessageRequestsPage />} />
          <Route path="requests/:host/:requestId" element={<MessageRequestPage />} />
          <Route path="u/:address" element={<ProfilePage />} />
          <Route path="discover" element={<DiscoverPage />} />
          <Route path="settings/:tab?" element={userSettings} />
          <Route path="admin/:tab?" element={admin} />
        </Route>
      </Routes>
      <ReauthDialog />
      <DownloadWarningDialog />
      <ConfirmHost />
      <TermsGate />
      <DateOfBirthGate />
    </BrowserRouter>
  );
}
