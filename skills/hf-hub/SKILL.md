# HuggingFace Hub

Use this skill when the user asks about a HuggingFace Hub model, dataset, or Space.

## Tool

- `hf_hub_info(repo_id, repo_type)` — look up metadata for any public (or accessible-with-token) HF Hub repo.

## When to use

- The user mentions a model id like `meta-llama/Llama-2-7b-hf` or `microsoft/resnet-50`.
- The user asks which task a model is for, how popular it is (downloads/likes), or whether it is gated.
- The user references a dataset like `EleutherAI/pile` or `wikitext`.
- The user wants to know what SDK a Space uses (Gradio, Streamlit, etc.).

## Examples

- User: "What is the task for sentence-transformers/all-MiniLM-L6-v2?"
  - Call `hf_hub_info({"repo_id": "sentence-transformers/all-MiniLM-L6-v2", "repo_type": "model"})`.
- User: "Is the Llama-2-7b model gated?"
  - Call `hf_hub_info({"repo_id": "meta-llama/Llama-2-7b-hf", "repo_type": "model"})` and read the gated field.
- User: "What SDK does philschmid/document-ai use?"
  - Call `hf_hub_info({"repo_id": "philschmid/document-ai", "repo_type": "space"})`.

## Notes

- `repo_type` defaults to `model`. Use `dataset` for datasets and `space` for Spaces.
- Public repos do not need a token. Private or gated repos require the HF_TOKEN environment variable.
- If the repo is not found, the tool returns a clear "not found" message.
