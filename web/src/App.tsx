// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { LoginPage } from "./pages/LoginPage";
import { AppLayout } from "./pages/AppLayout";
import { HomePage } from "./pages/HomePage";
import { ChannelPage, RoomIndexRedirect } from "./pages/ChannelPage";
import { InvitePage } from "./pages/InvitePage";
import { AddApplicationPage } from "./pages/AddApplicationPage";
import { RoomSettingsPage } from "./pages/settings/RoomSettingsPage";
import { UserSettingsPage } from "./pages/UserSettingsPage";
import { AdminPage } from "./pages/AdminPage";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/PasswordResetPages";
import { EncryptionPage } from "./pages/EncryptionPage";
import { ConversationPage } from "./pages/DirectMessages";
import { FriendsPage } from "./pages/FriendsPage";
import { ConnectCallbackPage, ConnectPage } from "./pages/ConnectPages";
import { SsoCallbackPage } from "./pages/SsoCallbackPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { ProfilePage } from "./pages/ProfilePage";
import { MessageRequestPage, MessageRequestsPage } from "./pages/MessageRequestsPage";
import { ReauthDialog } from "./components/ReauthDialog";
import { TermsGate } from "./components/legal/TermsGate";
import { LegalDocumentPage, LegalIndexPage, NoticeFormPage, NoticeStatusPage } from "./pages/legal/LegalPages";
import { NodePickerPage } from "./pages/NodePickerPage";
import { platform } from "./platform";

// The whiteboard page (and with it the Excalidraw canvas) is loaded only when a board is opened.
const WhiteboardPage = lazy(() => import("./whiteboard/WhiteboardPage").then((m) => ({ default: m.WhiteboardPage })));
const whiteboard = (
  <Suspense fallback={null}>
    <WhiteboardPage />
  </Suspense>
);

export function App() {
  const desktop = platform().isDesktop;
  // The desktop app without a home node yet: the node picker for every path (docs/DESKTOP.md).
  if (desktop && !platform().node?.current()) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<NodePickerPage />} />
        </Routes>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter>
      <Routes>
        {/* Desktop app: change the home node (Settings → App). */}
        {desktop && <Route path="/node" element={<NodePickerPage />} />}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/encryption" element={<EncryptionPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/invite/:code" element={<InvitePage />} />
        {/* Add links of applications (APPLICATIONS.md §4.1), also of other nodes. */}
        <Route path="/add/:id" element={<AddApplicationPage />} />
        <Route path="/add/:domain/:id" element={<AddApplicationPage />} />
        {/* Sign-in with an account of this node on another node's web client (FEDERATION.md §8). */}
        <Route path="/connect" element={<ConnectPage />} />
        <Route path="/connect/callback" element={<ConnectCallbackPage />} />
        <Route path="/sso/callback" element={<SsoCallbackPage />} />
        {/* Legal pages, the notice form and its status page (design note 4.14); public. */}
        <Route path="/legal" element={<LegalIndexPage />} />
        <Route path="/legal/notice" element={<NoticeFormPage />} />
        <Route path="/legal/notice/:caseId" element={<NoticeStatusPage />} />
        <Route path="/legal/:kind" element={<LegalDocumentPage />} />
        <Route path="/" element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="rooms/:roomId" element={<RoomIndexRedirect />} />
          {/* The thread panel is part of the channel page (it stays mounted while threads open and close). */}
          <Route path="rooms/:roomId/channels/:channelId" element={<ChannelPage />}>
            <Route path="threads/:threadId" element={null} />
          </Route>
          {/* The whiteboard of a conversation, full screen (design note 4.10). */}
          <Route path="rooms/:roomId/channels/:channelId/whiteboard" element={whiteboard} />
          <Route path="rooms/:roomId/settings/:tab?" element={<RoomSettingsPage />} />
          {/* Rooms of other nodes: ids are node-scoped (`<domain>/<ulid>`). */}
          <Route path="n/:node/rooms/:roomId" element={<RoomIndexRedirect />} />
          {/* The thread panel is part of the channel page (it stays mounted while threads open and close). */}
          <Route path="n/:node/rooms/:roomId/channels/:channelId" element={<ChannelPage />}>
            <Route path="threads/:threadId" element={null} />
          </Route>
          <Route path="n/:node/rooms/:roomId/channels/:channelId/whiteboard" element={whiteboard} />
          <Route path="n/:node/rooms/:roomId/settings/:tab?" element={<RoomSettingsPage />} />
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
          <Route path="settings/:tab?" element={<UserSettingsPage />} />
          <Route path="admin/:tab?" element={<AdminPage />} />
        </Route>
      </Routes>
      <ReauthDialog />
      <TermsGate />
    </BrowserRouter>
  );
}
