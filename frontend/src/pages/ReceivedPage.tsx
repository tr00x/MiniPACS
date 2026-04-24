import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Inbox, RefreshCw } from "lucide-react";
import { TableSkeleton } from "@/components/TableSkeleton";
import { PageError } from "@/components/page-error";
import { ModalityBadgeList } from "@/components/ui/modality-badge";
import api, { getErrorMessage } from "@/lib/api";
import { formatDicomName, formatDicomDate } from "@/lib/dicom";

interface ReceivedItem {
  study_id: string;
  patient_id: string;
  patient_name: string;
  patient_dicom_id: string;
  study_description: string;
  study_date: string;
  accession_number: string;
  modalities: string;
  sender_aet: string;
  sender_ip: string;
  called_aet: string;
  transfer_syntax: string;
  received_at: string;
}

function formatReceptionDate(s: string): string {
  // Orthanc format: YYYYMMDDTHHMMSS
  if (!s || s.length < 15) return s;
  const date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const time = `${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
  return `${date} ${time}`;
}

export function ReceivedPage() {
  const [items, setItems] = useState<ReceivedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const { data } = await api.get("/received?limit=100");
      setItems(data.items || []);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  if (error) {
    return <PageError message={error} onRetry={handleRefresh} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Inbox className="h-6 w-6 text-muted-foreground" />
          <h2 className="text-2xl font-semibold tracking-tight">Received Studies</h2>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Studies sent to MINIPACS via DICOM C-STORE by external modalities or PACS systems.
        Shows the most recent 100 receipts.
      </p>

      {loading ? (
        <TableSkeleton rows={10} columns={7} />
      ) : items.length === 0 ? (
        <div className="rounded-lg border bg-muted/30 p-8 text-center">
          <Inbox className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No DICOM receipts yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            External facilities can send studies to this PACS — see connection details on the
            <Link to="/pacs-nodes" className="underline ml-1">PACS Nodes page</Link>.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Sender AET</TableHead>
                <TableHead>Sender IP</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Study</TableHead>
                <TableHead>Modality</TableHead>
                <TableHead>Study Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.study_id} className="hover:bg-muted/50">
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatReceptionDate(r.received_at)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.sender_aet || "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{r.sender_ip || "—"}</TableCell>
                  <TableCell>
                    <Link to={`/patients/${r.patient_id}`} className="hover:underline">
                      {formatDicomName(r.patient_name) || r.patient_dicom_id || "—"}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link to={`/studies/${r.study_id}`} className="hover:underline">
                      {r.study_description || "—"}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ModalityBadgeList modalities={r.modalities ? r.modalities.split(/[\\,]/).filter(Boolean) : []} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDicomDate(r.study_date)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
