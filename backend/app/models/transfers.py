from pydantic import BaseModel


class TransferRequest(BaseModel):
    study_id: str
    pacs_node_id: int
