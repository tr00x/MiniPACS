import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TableSkeleton } from "@/components/TableSkeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Plus, Pencil, Trash2, Radio } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { usePacsNodes, useInvalidate, qk } from "@/hooks/queries";

interface PacsNode {
  id: number;
  name: string;
  ae_title: string;
  ip: string;
  port: number;
  description: string | null;
  is_active: number;
  last_echo_at: string | null;
}

interface NodeForm {
  name: string;
  ae_title: string;
  ip: string;
  port: string;
  description: string;
  is_active: boolean;
}

const emptyForm: NodeForm = { name: "", ae_title: "", ip: "", port: "4242", description: "", is_active: true };

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function echoStatus(lastEchoAt: string | null): "online" | "warning" | null {
  if (!lastEchoAt) return null;
  const diffMs = Date.now() - new Date(lastEchoAt).getTime();
  const tenMinutes = 10 * 60 * 1000;
  return diffMs <= tenMinutes ? "online" : "warning";
}

export function PacsNodesPage() {
  const pacsNodesQuery = usePacsNodes();
  const nodes: PacsNode[] = (pacsNodesQuery.data as PacsNode[]) ?? [];
  const loading = pacsNodesQuery.isLoading;
  const error = pacsNodesQuery.error
    ? ((pacsNodesQuery.error as any)?.response?.data?.detail ?? (pacsNodesQuery.error as any)?.message ?? "Failed to load PACS nodes")
    : null;
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<NodeForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [echoResults, setEchoResults] = useState<Record<number, boolean | "testing">>({});
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  // Data loaded via usePacsNodes above. Mutations call
  // invalidate.afterPacsNodeChange() to ripple into study.pacs_nodes, transfers,
  // and dashboard caches.

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogError(null);
    setDialogOpen(true);
  };

  const openEdit = (n: PacsNode) => {
    setEditingId(n.id);
    setForm({
      name: n.name,
      ae_title: n.ae_title,
      ip: n.ip,
      port: String(n.port),
      description: n.description || "",
      is_active: !!n.is_active,
    });
    setDialogError(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setDialogError(null);
    const payload = { ...form, port: Number(form.port), is_active: form.is_active };
    try {
      if (editingId) {
        await api.put(`/pacs-nodes/${editingId}`, payload);
      } else {
        await api.post("/pacs-nodes", payload);
      }
      setDialogOpen(false);
      invalidate.afterPacsNodeChange();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setDialogError(e?.response?.data?.detail ?? e?.message ?? "Failed to save node");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (deleteTarget === null) return;
    const targetId = deleteTarget;
    // Optimistic: drop the row immediately from the cached list. Rollback on error.
    const nodesKey = qk.pacsNodes();
    const previous = qc.getQueryData(nodesKey);
    qc.setQueryData(nodesKey, (old: PacsNode[] | undefined) =>
      Array.isArray(old) ? old.filter((n) => n.id !== targetId) : old,
    );
    setDeleteTarget(null);
    setDeleting(true);
    try {
      await api.delete(`/pacs-nodes/${targetId}`);
      invalidate.afterPacsNodeChange();
    } catch (err: unknown) {
      qc.setQueryData(nodesKey, previous);
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      toast.error(e?.response?.data?.detail ?? e?.message ?? "Failed to delete node");
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleActive = async (n: PacsNode) => {
    setTogglingId(n.id);
    try {
      await api.put(`/pacs-nodes/${n.id}`, { is_active: !n.is_active });
      invalidate.afterPacsNodeChange();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      toast.error(e?.response?.data?.detail ?? e?.message ?? "Failed to update node");
    } finally {
      setTogglingId(null);
    }
  };

  const handleEcho = async (id: number) => {
    setEchoResults((prev) => ({ ...prev, [id]: "testing" }));
    try {
      const { data } = await api.post(`/pacs-nodes/${id}/echo`);
      setEchoResults((prev) => ({ ...prev, [id]: data.success }));
      // Refresh nodes to get updated last_echo_at
      invalidate.afterPacsNodeChange();
    } catch {
      setEchoResults((prev) => ({ ...prev, [id]: false }));
    }
  };

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">PACS Nodes</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">PACS Nodes</h2>
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add Node
        </Button>
      </div>

      {/* Receiving info card — share with external facilities */}
      <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
        <p className="text-sm font-medium">Receiving DICOM Studies</p>
        <p className="text-xs text-muted-foreground">
          To receive imaging studies from external equipment or facilities, provide them with the following connection details:
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">AE Title</p>
            <p className="font-mono font-medium text-sm">MINIPACS</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">IP Address</p>
            <p className="font-mono font-medium text-sm">{window.location.hostname}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">DICOM Port</p>
            <p className="font-mono font-medium text-sm">48924</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Protocol</p>
            <p className="font-mono font-medium text-sm">C-STORE</p>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          Equipment (MRI, CT, X-ray) should be configured to send studies to this address via DICOM C-STORE.
        </p>
      </div>

      {/* Outbound nodes info */}
      <p className="text-xs text-muted-foreground">
        <strong>Outbound PACS nodes</strong> are destinations where you can send studies. Add a node with its AE Title, IP, and port, then use C-ECHO to verify connectivity before sending.
      </p>
      {loading ? (
        <div className="rounded-lg border">
          <TableSkeleton columns={9} />
        </div>
      ) : (
        <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>AE Title</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Port</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>C-ECHO</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((n) => {
              const status = echoStatus(n.last_echo_at);
              return (
                <TableRow key={n.id}>
                  <TableCell>
                    {status ? (
                      <div className="flex flex-col items-start">
                        <StatusDot status={status} />
                        <span className="text-[10px] text-muted-foreground mt-0.5">
                          {formatRelativeTime(n.last_echo_at!)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{n.name}</TableCell>
                  <TableCell className="font-medical-id text-sm">{n.ae_title}</TableCell>
                  <TableCell className="font-medical-id text-sm">{n.ip}</TableCell>
                  <TableCell>{n.port}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {n.description || "—"}
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => handleToggleActive(n)}
                      disabled={togglingId === n.id}
                      className="cursor-pointer disabled:opacity-50"
                      title={n.is_active ? "Click to deactivate" : "Click to activate"}
                    >
                      <Badge variant={n.is_active ? "default" : "secondary"}>
                        {togglingId === n.id ? "..." : (n.is_active ? "Active" : "Inactive")}
                      </Badge>
                    </button>
                  </TableCell>
                  <TableCell>
                    {echoResults[n.id] === "testing" ? (
                      <span className="text-xs text-muted-foreground">Testing...</span>
                    ) : echoResults[n.id] === true ? (
                      <Badge variant="default">OK</Badge>
                    ) : echoResults[n.id] === false ? (
                      <Badge variant="destructive">Failed</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => handleEcho(n.id)}>
                        <Radio className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => openEdit(n)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(n.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {nodes.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  No PACS nodes configured
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete PACS Node"
        description="This will permanently remove this node."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDeleteConfirm}
        loading={deleting}
      />

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setDialogError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit PACS Node" : "Add PACS Node"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. City Hospital Radiology" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ae_title">AE Title</Label>
              <Input id="ae_title" value={form.ae_title} onChange={(e) => setForm({ ...form, ae_title: e.target.value })} placeholder="e.g. CITYHOSPRAD" />
              <p className="text-[10px] text-muted-foreground">Application Entity Title — ask the receiving facility for this</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="ip">IP Address</Label>
                <Input id="ip" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} placeholder="192.168.1.100" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="port">Port</Label>
                <Input id="port" type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Primary hospital PACS for referrals" />
            </div>
            {editingId && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_active"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="is_active">Active</Label>
              </div>
            )}
          </div>
          {dialogError && (
            <p className="text-sm text-destructive" role="alert">{dialogError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : editingId ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
