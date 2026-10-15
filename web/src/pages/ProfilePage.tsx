// SPDX-License-Identifier: Apache-2.0
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { ProfileView, useProfile } from "../components/ProfilePopover";
import { isHome } from "../stores/nodes";

/**
 * The full profile (`/u/<address>`). `?via=<domain>` names the node whose copy is shown (a member of a
 * room on another node); without it the home node is asked.
 */
export function ProfilePage() {
  const t = useT();
  const navigate = useNavigate();
  const { address = "" } = useParams();
  const [params] = useSearchParams();
  const via = params.get("via");
  const node = via && !isHome(via) ? via : null;
  const profile = useProfile(address, node);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={() => navigate(-1)} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" aria-label={t("common.back")}>
          ←
        </button>
        <h1 className="truncate text-sm font-semibold">{t("profile.title")}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-0 sm:p-6">
        <div className="mx-auto max-w-2xl overflow-hidden rounded-none border-line bg-bg-1 sm:rounded-xl sm:border" data-testid="profile-page">
          {profile.isPending && <p className="p-4 text-sm text-fg-2">{t("common.loading")}</p>}
          {profile.isError && <p className="p-4 text-sm text-danger">{describeError(profile.error)}</p>}
          {profile.data && <ProfileView profile={profile.data} node={node} large />}
        </div>
      </div>
    </div>
  );
}
