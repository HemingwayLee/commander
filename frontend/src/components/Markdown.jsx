import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Box } from "@mui/material";

export default function Markdown({ children }) {
  return (
    <Box
      sx={{
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        "& p": { my: 1, lineHeight: 1.7 },
        "& a": { color: "primary.main" },
        "& code": {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "0.875em",
          bgcolor: "action.hover",
          px: 0.5,
          borderRadius: 0.5,
        },
        "& pre": {
          bgcolor: "action.hover",
          p: 1.5,
          borderRadius: 1,
          overflowX: "auto",
          "& code": { bgcolor: "transparent", p: 0 },
        },
        "& table": { borderCollapse: "collapse", my: 1 },
        "& th, & td": { border: 1, borderColor: "divider", px: 1, py: 0.5 },
        "& blockquote": { borderLeft: 3, borderColor: "divider", pl: 2, ml: 0, color: "text.secondary" },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href = "", children: text, node: _node, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}
