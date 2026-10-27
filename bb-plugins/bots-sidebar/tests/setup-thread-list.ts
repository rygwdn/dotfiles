import { beforeEach } from "vitest";
import { resetPreferencesSyncForTest, setPreferencesMirrorStorageForTest } from "../.generated/bb/thread-list/app/preferences/preferences-sync";
import { resetSidebarDataCacheForTest } from "../.generated/bb/thread-list/app/model/use-sidebar-data";

beforeEach(() => {
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(null);
  resetSidebarDataCacheForTest();
});
