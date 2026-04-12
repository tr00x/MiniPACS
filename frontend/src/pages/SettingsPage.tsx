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
import { Plus, Trash2, ShieldOff } from "lucide-react";
import api from "@/lib/api";

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
  is_enabled: number;
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
  const [viewerForm, setViewerForm] = useState({ name: "", url_scheme: "" });
  const [viewerDialogError, setViewerDialogError] = useState<string | null>(null);

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
      await api.put("/settings", { settings });
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
    if (!confirm("Delete this user?")) return;
    try {
      await api.delete(`/users/${id}`);
      setUsers(users.filter((u) => u.id !== id));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to delete user");
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

  const handleAddViewer = async () => {
    setViewerDialogError(null);
    try {
      const { data } = await api.post("/viewers", { ...viewerForm, is_enabled: true });
      setViewers([...viewers, data]);
      setViewerDialogOpen(false);
      setViewerForm({ name: "", url_scheme: "" });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setViewerDialogError(e?.response?.data?.detail ?? e?.message ?? "Failed to add viewer");
    }
  };

  const handleDeleteViewer = async (id: number) => {
    try {
      await api.delete(`/viewers/${id}`);
      setViewers(viewers.filter((v) => v.id !== id));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to delete viewer");
    }
  };

  const handleToggleViewer = async (v: Viewer) => {
    try {
      await api.put(`/viewers/${v.id}`, { is_enabled: !v.is_enabled });
      setViewers(viewers.map((x) => x.id === v.id ? { ...x, is_enabled: x.is_enabled ? 0 : 1 } : x));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to update viewer");
    }
  };

  if (loading) return <p className="text-muted-foreground">Loading...</p>;
  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
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
                <Label htmlFor="portal_name">Portal Name</Label>
                <Input
                  id="portal_name"
                  value={settings.portal_name || ""}
                  onChange={(e) => setSettings({ ...settings, portal_name: e.target.value })}
                />
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
                      <TableCell className="text-xs">{u.created_at}</TableCell>
                      <TableCell>{u.token_version}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => handleRevokeTokens(u.id)} title="Revoke tokens">
                            <ShieldOff className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDeleteUser(u.id)} title="Delete user">
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
              <Button size="sm" onClick={() => { setViewerDialogOpen(true); setViewerDialogError(null); }}>
                <Plus className="mr-1 h-4 w-4" /> Add Viewer
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>URL Scheme</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {viewers.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-medium">{v.name}</TableCell>
                      <TableCell className="font-mono text-xs max-w-xs truncate">{v.url_scheme}</TableCell>
                      <TableCell>
                        <Badge
                          variant={v.is_enabled ? "default" : "secondary"}
                          className="cursor-pointer"
                          onClick={() => handleToggleViewer(v)}
                        >
                          {v.is_enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => handleDeleteViewer(v.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
            </div>
          </div>
          {userDialogError && <p className="text-sm text-destructive" role="alert">{userDialogError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUserDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAddUser}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={viewerDialogOpen} onOpenChange={(open) => { setViewerDialogOpen(open); if (!open) setViewerDialogError(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add External Viewer</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="viewer_name">Name</Label>
              <Input id="viewer_name" value={viewerForm.name} onChange={(e) => setViewerForm({ ...viewerForm, name: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="viewer_url">URL Scheme</Label>
              <Input id="viewer_url" value={viewerForm.url_scheme} onChange={(e) => setViewerForm({ ...viewerForm, url_scheme: e.target.value })} placeholder="radiant://..." />
            </div>
          </div>
          {viewerDialogError && <p className="text-sm text-destructive" role="alert">{viewerDialogError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewerDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAddViewer}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
