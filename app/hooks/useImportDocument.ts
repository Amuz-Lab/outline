import invariant from "invariant";
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useHistory } from "react-router-dom";
import { toast } from "sonner";
import { errToString } from "@shared/utils/error";
import { useSidebarContext } from "~/components/Sidebar/components/SidebarContext";
import useStores from "~/hooks/useStores";
import { documentPath } from "~/utils/routeHelpers";
import { readHtmlPreviewFile } from "~/utils/htmlPreviewImport";

let importingLock = false;

export default function useImportDocument(
  collectionId?: string | null,
  documentId?: string,
  htmlPreview = false
): {
  handleFiles: (files: File[]) => Promise<void>;
  isImporting: boolean;
} {
  const { documents, collections } = useStores();
  const sidebarContext = useSidebarContext();
  const [isImporting, setImporting] = useState(false);
  const { t } = useTranslation();
  const history = useHistory();
  const handleFiles = useCallback(
    async (files: File[] = []) => {
      if (importingLock) {
        return;
      }

      // Because this is the onChange handler it's possible for the change to be
      // from previously selecting a file to not selecting a file – aka empty
      if (!files.length) {
        return;
      }

      setImporting(true);
      importingLock = true;

      try {
        let cId = collectionId;
        const redirect = files.length === 1;

        if (documentId && !collectionId) {
          const document = await documents.fetch(documentId);
          invariant(document, "Document not available");
          cId = document.collectionId;
        }

        for (const file of files) {
          const toastId = toast.loading(`${t("Uploading")}…`);

          try {
            const preview = htmlPreview
              ? await readHtmlPreviewFile(file)
              : undefined;
            const doc = preview
              ? await documents.create(
                  {
                    ...preview,
                    collectionId: cId,
                    parentDocumentId: documentId,
                  },
                  { publish: true }
                )
              : await documents.import(file, documentId, cId, {
                  publish: true,
                });

            if (preview && cId) {
              collections.get(cId)?.addDocument(doc, documentId);
            }

            if (redirect) {
              history.push({
                pathname: documentPath(doc),
                state: { sidebarContext },
              });
            }
          } catch (err) {
            toast.error(errToString(err));
          } finally {
            toast.dismiss(toastId);
          }
        }
      } catch (err) {
        toast.error(`${t("Could not import file")}. ${errToString(err)}`);
      } finally {
        setImporting(false);
        importingLock = false;
      }
    },
    [
      t,
      documents,
      collections,
      history,
      collectionId,
      sidebarContext,
      documentId,
      htmlPreview,
    ]
  );

  return {
    handleFiles,
    isImporting,
  };
}
