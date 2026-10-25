You type one question into an AI chatbot. You hit enter. And about two seconds later, words start pouring back.

It feels like magic. It isn't. It's one of the most impressive relay races ever built... and almost nobody has seen the whole track.

So let's run it. Every leg. From your keyboard, to a GPU in a data center, and back.

It starts in your browser. Before a single word of your question goes anywhere, your computer needs to know where it's going. So it asks DNS... the Domain Name System... a simple question: where does this name live?

DNS is the internet's phone book. Your request hops from a resolver to a root server, to a top-level domain server, to the one server that actually knows the answer. And it comes back with an IP address. A number. That whole lookup? Usually a few milliseconds. And next time, it's cached.

Now your browser knows where to go. So it opens a connection. TCP shakes hands... syn, syn-ack, ack. Three messages, just to say hello.

Then comes TLS. This is the lock icon in your address bar. Your browser and the server agree on encryption keys, using public-key cryptography, so that everything after this point is scrambled for anyone listening in between. Your Wi-Fi router, your internet provider, the coffee shop network... they all see noise.

And only now... after DNS, after TCP, after TLS... does your actual question leave your machine. As an HTTP request. Probably HTTP two, or HTTP three over QUIC, which runs on UDP to shave off even more round trips.

Inside that request is a little package of JSON. Your message. The model name. A few settings. And a token, usually a JWT, that proves you're logged in. You got that token earlier through OAuth, when you clicked "Sign in with Google." So the server never sees your Google password. Ever.

Here's the twist. That request almost never goes straight to the AI. It hits a CDN first. A content delivery network. Thousands of servers spread around the planet, so the first thing you touch is physically close to you. The CDN absorbs attacks, handles the encryption, and serves anything it can from its cache.

Your question can't be cached, though. It's brand new. So the CDN forwards it to a load balancer.

The load balancer has one job: pick a server that isn't busy. Round robin, least connections, whatever the strategy... it spreads millions of requests across a fleet of machines so no single one melts.

Then the API gateway. This is the bouncer at the door. Is your token valid? Have you hit your rate limit? Are you sending a request that's way too big? If anything's off, you get a four-twenty-nine, or a four-oh-one, and the journey ends right here.

If you pass, you're inside. And inside is not one program. It's dozens of microservices. Small, separate services, each doing one thing well. One handles your account. One stores your chat history. One checks your message for safety. One talks to the model.

Every one of them runs in a container. Docker packages the code with everything it needs, so it runs the same on a laptop as it does in production. And Kubernetes is the conductor. It decides which machine each container runs on. It restarts them when they crash. It scales them up when traffic spikes at nine a.m., and back down at three in the morning.

Your chat history? That's sitting in a database. Probably Postgres. Rows and columns, with indexes so it can find your conversation in milliseconds instead of scanning every message ever sent.

And sitting in front of that database is Redis. An in-memory cache. Reading from RAM instead of disk is the difference between a microsecond and a millisecond. Doesn't sound like much... until you multiply it by a hundred million users.

Now, some AI apps do one more thing before the model ever sees your question. It's called RAG. Retrieval-Augmented Generation.

Your question gets turned into an embedding. A long list of numbers, a vector, that captures what your question means. Not the words. The meaning. That vector goes to a vector database, which finds the documents with the closest meaning. Then those documents get stuffed into the prompt, right next to your question. So the model answers from real facts, instead of guessing.

Okay. Now we finally reach the model.

First, your text gets tokenized. The model doesn't read words. It reads tokens. Chunks of text, roughly three quarters of a word each. "Unbelievable" might be three tokens. Each token becomes a number. And each number becomes an embedding... a vector with thousands of dimensions.

Then those vectors go through a transformer.

The transformer is the architecture behind basically every modern language model. And its secret weapon is attention. Every token looks at every other token and asks: which of you matter to me? In the sentence "the bank of the river," attention is how "bank" figures out it's about water, not money.

That happens in parallel, across dozens of attention heads, stacked in dozens of layers. Billions of parameters. Each one just a number, learned during training, by showing the model trillions of tokens and nudging every number, a tiny bit, every time it guessed wrong. That's gradient descent. Repeated for months.

And all of this... every single attention calculation... is matrix multiplication.

Which is why it runs on a GPU.

A CPU is a few brilliant workers. A GPU is thousands of simple workers, all doing math at the exact same time. Matrix multiplication is the perfect job for them. Modern data-center GPUs, like the H one hundred, or the B two hundred, have tensor cores... circuits built for one thing only: multiplying matrices, absurdly fast.

The software that talks to those cores is CUDA. And on top of CUDA sits PyTorch, which is what most researchers actually write.

But here's what nobody tells you. The math is not the bottleneck. Memory is.

The model's weights live in HBM. High Bandwidth Memory, stacked right next to the chip. And for every single token the model generates, it has to read through those weights. Gigabytes of them. Over and over. The GPU spends a lot of its life just... waiting for data.

So engineers get clever.

Quantization. Store each weight in eight bits instead of sixteen. FP8. Or even four bits. Half the memory, half the traffic, almost the same quality.

The KV cache. Instead of recomputing attention for every earlier token, every single time, the model saves those results and reuses them. That's why the second word arrives faster than the first.

Batching. Your question doesn't run alone. Serving engines like vLLM squeeze dozens of users' requests onto the same GPU at the same moment. Continuous batching means the second your answer finishes, someone else's slides into your slot. Nothing sits idle.

And then, the model makes its prediction.

One token.

That's it. That's the whole trick. It predicts the single most likely next token, picks one, adds it to the text... and runs the entire thing again. Token by token. Hundreds of times. That's why AI text appears word by word. It literally is being written word by word.

Those tokens don't wait for the full answer. They stream back to you, using server-sent events or a WebSocket. Back through the gateway. Back through the load balancer. Back through the CDN. Encrypted with TLS. Into your browser, where JavaScript catches each piece and paints it onto the screen.

All of that... in about two seconds.

And while it happened, an entire second system was watching.

Observability. Logs, metrics, and traces. Every service records what it did and how long it took. Engineers watch the p ninety-nine latency... the slowest one percent of requests... because averages lie. If one in a hundred users waits ten seconds, that's a million angry people a day.

When something breaks at three a.m., an alert fires. Someone's phone buzzes. They open a dashboard, follow a trace across twelve services, and find the one slow query hiding in a loop.

And the fix? It goes through Git. A pull request. Code review. Then CI/CD... continuous integration, continuous delivery... runs thousands of automated tests, builds a new container, and rolls it out. Slowly. One percent of servers first. Then ten. Then everyone. If the error rate jumps, it rolls itself back.

So let's zoom out.

DNS. TCP. TLS. HTTP. CDN. Load balancer. API gateway. OAuth. Microservices. Docker. Kubernetes. Postgres. Redis. Embeddings. A vector database. A tokenizer. A transformer. Attention. A GPU. CUDA. Tensor cores. HBM. Quantization. The KV cache. Batching. Streaming. Observability. CI/CD.

Thirty-something technologies. Built by thousands of people. Over fifty years.

All so that you can type one question... and get an answer before you've finished reaching for your coffee.

Honestly? That's the most underrated miracle in tech.

If this made the whole stack click for you, share it with the one friend who still thinks AI is magic. And I'll see you in the next one.
