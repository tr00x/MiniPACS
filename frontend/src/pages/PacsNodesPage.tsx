import { useEffect, useState } from "react";
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
import { Plus, Pencil, Trash2, Radio } from "lucide-react";
import api from "@/lib/api";

interface PacsNode {
  id: number;
  name: string;
  ae_title: string;
  ip: string;
  port: number;
  description: string | null;
  is_active: number;
}

interface NodeForm {
  name: string;
  ae_title: string;
  ip: string;
  port: string;
  description: string;
}

const emptyForm: NodeForm = { name: "", ae_title: "", ip: "", port: "4242", description: "" };

export function PacsNodesPage() {
  const [nodes, setNodes] = useState<PacsNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<NodeForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [echoResults, setEchoResults] = useState<Record<number, boolean | "testing">>({});

  const fetchNodes = (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    api
      .get("/pacs-nodes", { signal })
      .then(({ data }) => setNodes(data))
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load PACS nodes");
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const ctrl = new AbortController();
    fetchNodes(ctrl.signal);
    return () => ctrl.abort();
  }, []);

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
    });
    setDialogError(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setDialogError(null);
    const payload = { ...form, port: Number(form.port) };
    try {
      if (editingId) {
        await api.put(`/pacs-nodes/${editingId}`, payload);
      } else {
        await api.post("/pacs-nodes", payload);
      }
      setDialogOpen(false);
      fetchNodes();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setDialogError(e?.response?.data?.detail ?? e?.message ?? "Failed to save node");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this PACS node?")) return;
    try {
      await api.delete(`/pacs-nodes/${id}`);
      fetchNodes();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to delete node");
    }
  };

  const handleEcho = async (id: number) => {
    setEchoResults((prev) => ({ ...prev, [id]: "testing" }));
    try {
      const { data } = await api.post(`/pacs-nodes/${id}/echo`);
      setEchoResults((prev) => ({ ...prev, [id]: data.success }));
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
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>AE Title</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Port</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>C-ECHO</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((n) => (
              <TableRow key={n.id}>
                <TableCell className="font-medium">{n.name}</TableCell>
                <TableCell className="font-mono text-sm">{n.ae_title}</TableCell>
                <TableCell className="font-mono text-sm">{n.ip}</TableCell>
                <TableCell>{n.port}</TableCell>
                <TableCell>
                  <Badge variant={n.is_active ? "default" : "secondary"}>
                    {n.is_active ? "Active" : "Inactive"}
                  </Badge>
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
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(n.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {nodes.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No PACS nodes configured
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setDialogError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit PACS Node" : "Add PACS Node"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ae_title">AE Title</Label>
              <Input id="ae_title" value={form.ae_title} onChange={(e) => setForm({ ...form, ae_title: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="ip">IP Address</Label>
                <Input id="ip" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="port">Port</Label>
                <Input id="port" type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
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
