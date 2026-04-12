import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Plus, Trash2, ShieldOff, Pencil, X, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import { PageLoader } from "@/components/PageLoader";
import { PageError } from "@/components/page-error";
import { formatTimestamp, VIEWER_COLORS, getViewerIconLabel } from "@/lib/dicom";

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

interface User {
  id: number;
  username: string;
  created_at: string;
  token_version: number;
}

interface Viewer {
  id: number;
  name: string;
  url_scheme: string;
  icon: string | null;
  sort_order: number;
  is_enabled: number;
  description?: string;
  icon_key?: string;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [users, setUsers] = useState<User[]>([]);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // User dialog
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [userDialogError, setUserDialogError] = useState<string | null>(null);

  // Viewer dialog
  const [viewerDialogOpen, setViewerDialogOpen] = useState(false);
  const [viewerEditingId, setViewerEditingId] = useState<number | null>(null);
  const [viewerForm, setViewerForm] = useState({ name: "", url_scheme: "", icon: "", sort_order: "0", description: "", icon_key: "" });
  const [viewerDialogError, setViewerDialogError] = useState<string | null>(null);

  // Confirm dialogs
  const [deleteUserId, setDeleteUserId] = useState<number | null>(null);
  const [deleteViewerId, setDeleteViewerId] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    Promise.all([
      api.get("/settings", { signal: ctrl.signal }),
      api.get("/users", { signal: ctrl.signal }),
      api.get("/viewers", { signal: ctrl.signal }),
    ])
      .then(([settingsRes, usersRes, viewersRes]) => {
        setSettings(settingsRes.data);
        setUsers(usersRes.data);
        setViewers(viewersRes.data);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load settings");
        }
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, []);

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string | number> = {};
      if (settings.clinic_name !== undefined) payload.clinic_name = settings.clinic_name;
      if (settings.clinic_phone !== undefined) payload.clinic_phone = settings.clinic_phone;
      if (settings.clinic_email !== undefined) payload.clinic_email = settings.clinic_email;
      if (settings.auto_logout_minutes) payload.auto_logout_minutes = Number(settings.auto_logout_minutes);
      if (settings.default_share_expiry_days) payload.default_share_expiry_days = Number(settings.default_share_expiry_days);
      if (settings.viewer_default !== undefined) payload.viewer_default = settings.viewer_default;
      await api.put("/settings", payload);
      toast.success("Settings saved");
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleAddUser = async () => {
    setUserDialogError(null);
    try {
      const { data } = await api.post("/users", { username: newUsername, password: newPassword });
      setUsers([...users, data]);
      setUserDialogOpen(false);
      setNewUsername("");
      setNewPassword("");
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setUserDialogError(e?.response?.data?.detail ?? e?.message ?? "Failed to create user");
    }
  };

  const handleDeleteUser = async (id: number) => {
    try {
      await api.delete(`/users/${id}`);
      setUsers(users.filter((u) => u.id !== id));
      setDeleteUserId(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to delete user");
      setDeleteUserId(null);
    }
  };

  const handleRevokeTokens = async (id: number) => {
    try {
      await api.post(`/users/${id}/revoke-tokens`);
      setUsers(users.map((u) => u.id === id ? { ...u, token_version: u.token_version + 1 } : u));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to revoke tokens");
    }
  };

  const handleSaveViewer = async () => {
    setViewerDialogError(null);
    const payload = {
      name: viewerForm.name,
      url_scheme: viewerForm.url_scheme,
      icon: viewerForm.icon || null,
      sort_order: Number(viewerForm.sort_order) || 0,
      is_enabled: true,
      description: viewerForm.description || "",
      icon_key: viewerForm.icon_key || "",
    };
    try {
      if (viewerEditingId) {
        await api.put(`/viewers/${viewerEditingId}`, payload);
        setViewers(viewers.map((v) => v.id === viewerEditingId ? { ...v, ...payload } : v));
      } else {
        const { data } = await api.post("/viewers", payload);
        setViewers([...viewers, data]);
      }
      toast.success(viewerEditingId ? "Viewer updated" : "Viewer added");
      setViewerDialogOpen(false);
      setViewerForm({ name: "", url_scheme: "", icon: "", sort_order: "0" });
      setViewerEditingId(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setViewerDialogError(e?.response?.data?.detail ?? e?.message ?? "Failed to save viewer");
    }
  };

  const openEditViewer = (v: Viewer) => {
    setViewerEditingId(v.id);
    setViewerForm({
      name: v.name,
      url_scheme: v.url_scheme,
      icon: v.icon || "",
      sort_order: String(v.sort_order || 0),
      description: v.description || "",
      icon_key: v.icon_key || "",
    });
    setViewerDialogError(null);
    setViewerDialogOpen(true);
  };

  const handleDeleteViewer = async (id: number) => {
    try {
      await api.delete(`/viewers/${id}`);
      setViewers(viewers.filter((v) => v.id !== id));
      setDeleteViewerId(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to delete viewer");
      setDeleteViewerId(null);
    }
  };

  const handleToggleViewer = async (v: Viewer) => {
    try {
      await api.put(`/viewers/${v.id}`, { is_enabled: !v.is_enabled });
      setViewers(viewers.map((x) => x.id === v.id ? { ...x, is_enabled: x.is_enabled ? 0 : 1 } : x));
      toast.success(`${v.name} ${v.is_enabled ? "disabled" : "enabled"}`);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      toast.error(e?.response?.data?.detail ?? e?.message ?? "Failed to update viewer");
    }
  };

  if (loading) return <PageLoader />;
  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <PageError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="viewers">External Viewers</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">General Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 max-w-sm">
                <Label htmlFor="clinic_name">Clinic Name</Label>
                <div className="relative">
                  <Input
                    id="clinic_name"
                    value={settings.clinic_name || ""}
                    onChange={(e) => setSettings({ ...settings, clinic_name: e.target.value })}
                    className="pr-8"
                  />
                  {settings.clinic_name && (
                    <button
                      type="button"
                      onClick={() => setSettings({ ...settings, clinic_name: "" })}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid gap-2 max-w-sm">
                <Label htmlFor="clinic_phone">Clinic Phone</Label>
                <div className="relative">
                  <Input
                    id="clinic_phone"
                    value={settings.clinic_phone || ""}
                    onChange={(e) => setSettings({ ...settings, clinic_phone: e.target.value })}
                    placeholder="+1 (555) 000-0000"
                    className="pr-8"
                  />
                  {settings.clinic_phone && (
                    <button
                      type="button"
                      onClick={() => setSettings({ ...settings, clinic_phone: "" })}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid gap-2 max-w-sm">
                <Label htmlFor="clinic_email">Clinic Email</Label>
                <div className="relative">
                  <Input
                    id="clinic_email"
                    type="email"
                    value={settings.clinic_email || ""}
                    onChange={(e) => setSettings({ ...settings, clinic_email: e.target.value })}
                    placeholder="clinic@example.com"
                    className="pr-8"
                  />
                  {settings.clinic_email && (
                    <button
                      type="button"
                      onClick={() => setSettings({ ...settings, clinic_email: "" })}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid gap-2 max-w-sm">
                <Label htmlFor="auto_logout">Auto-Logout (minutes)</Label>
                <Input
                  id="auto_logout"
                  type="number"
                  value={settings.auto_logout_minutes || "15"}
                  onChange={(e) => setSettings({ ...settings, auto_logout_minutes: e.target.value })}
                />
              </div>
              <div className="grid gap-2 max-w-sm">
                <Label htmlFor="default_share_expiry">Default Share Expiry (days)</Label>
                <Input
                  id="default_share_expiry"
                  type="number"
                  value={settings.default_share_expiry_days || "30"}
                  onChange={(e) => setSettings({ ...settings, default_share_expiry_days: e.target.value })}
                />
              </div>
              <Button onClick={handleSaveSettings} disabled={saving}>
                {saving ? "Saving..." : "Save Settings"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium">Users</CardTitle>
              <Button size="sm" onClick={() => { setUserDialogOpen(true); setUserDialogError(null); }}>
                <Plus className="mr-1 h-4 w-4" /> Add User
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Username</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Token Version</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.username}</TableCell>
                      <TableCell className="text-xs" title={formatTimestamp(u.created_at)}>{formatRelativeTime(u.created_at)}</TableCell>
                      <TableCell>{u.token_version}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => handleRevokeTokens(u.id)} title="Revoke tokens">
                            <ShieldOff className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleteUserId(u.id)} title="Delete user">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="viewers">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium">External Viewers</CardTitle>
              <Button size="sm" onClick={() => { setViewerEditingId(null); setViewerForm({ name: "", url_scheme: "", icon: "", sort_order: "0", description: "", icon_key: "" }); setViewerDialogOpen(true); setViewerDialogError(null); }}>
                <Plus className="mr-1 h-4 w-4" /> Add Viewer
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {viewers.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">No external viewers configured. Add one to get started.</p>
                )}
                {viewers.map((v) => (
                  <div key={v.id} className="flex items-center gap-4 rounded-lg border p-4">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-lg text-xs font-bold shrink-0 ${(VIEWER_COLORS[v.icon_key || ""] || ["bg-muted", "text-foreground"]).join(" ")}`}>
                      {getViewerIconLabel(v.name, v.icon_key)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{v.name}</span>
                        {v.is_enabled ? (
                          <Badge variant="default" className="text-[10px]">Active</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">Disabled</Badge>
                        )}
                      </div>
                      {v.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{v.description}</p>
                      )}
                      <code className="text-[10px] text-muted-foreground/60 font-mono truncate block mt-0.5">{v.url_scheme}</code>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="icon" onClick={() => handleToggleViewer(v)} title={v.is_enabled ? "Disable" : "Enable"}>
                        {v.is_enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => openEditViewer(v)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteViewerId(v.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={userDialogOpen} onOpenChange={(open) => { setUserDialogOpen(open); if (!open) setUserDialogError(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add User</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="new_username">Username</Label>
              <Input id="new_username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new_password">Password</Label>
              <Input id="new_password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
              <p className="text-xs text-muted-foreground">Minimum 8 characters</p>
            </div>
          </div>
          {userDialogError && <p className="text-sm text-destructive" role="alert">{userDialogError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUserDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAddUser}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={viewerDialogOpen} onOpenChange={(open) => { setViewerDialogOpen(open); if (!open) { setViewerDialogError(null); setViewerEditingId(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{viewerEditingId ? "Edit External Viewer" : "Add External Viewer"}</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="viewer_name">Name</Label>
              <Input id="viewer_name" value={viewerForm.name} onChange={(e) => setViewerForm({ ...viewerForm, name: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="viewer_description">Description</Label>
              <Input id="viewer_description" value={viewerForm.description} onChange={(e) => setViewerForm({ ...viewerForm, description: e.target.value })} placeholder="Short description of the viewer" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="viewer_url">URL Scheme</Label>
              <Input id="viewer_url" value={viewerForm.url_scheme} onChange={(e) => setViewerForm({ ...viewerForm, url_scheme: e.target.value })} placeholder="/ohif/viewer?StudyInstanceUIDs={StudyInstanceUID}" />
              <p className="text-xs text-muted-foreground">Use {"{StudyInstanceUID}"} or {"{study_id}"} as placeholders</p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="viewer_icon_key">Icon Key</Label>
                <Input id="viewer_icon_key" value={viewerForm.icon_key} onChange={(e) => setViewerForm({ ...viewerForm, icon_key: e.target.value })} placeholder="e.g. ohif" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="viewer_icon">Icon (legacy)</Label>
                <Input id="viewer_icon" value={viewerForm.icon} onChange={(e) => setViewerForm({ ...viewerForm, icon: e.target.value })} placeholder="e.g. radiant" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="viewer_sort">Sort Order</Label>
                <Input id="viewer_sort" type="number" value={viewerForm.sort_order} onChange={(e) => setViewerForm({ ...viewerForm, sort_order: e.target.value })} />
              </div>
            </div>
          </div>
          {viewerDialogError && <p className="text-sm text-destructive" role="alert">{viewerDialogError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewerDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveViewer}>{viewerEditingId ? "Update" : "Add"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteUserId !== null}
        onOpenChange={(open) => { if (!open) setDeleteUserId(null); }}
        title="Delete User"
        description="Are you sure you want to delete this user? This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => { if (deleteUserId !== null) handleDeleteUser(deleteUserId); }}
      />

      <ConfirmDialog
        open={deleteViewerId !== null}
        onOpenChange={(open) => { if (!open) setDeleteViewerId(null); }}
        title="Delete Viewer"
        description="Are you sure you want to delete this viewer? This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => { if (deleteViewerId !== null) handleDeleteViewer(deleteViewerId); }}
      />
    </div>
  );
}
