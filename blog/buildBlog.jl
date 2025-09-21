using CommonMark 
using Markdown
using Glob 

posts_dir = "blog/posts"
output_dir = "blog/posts/generated"


test = glob("*.md", posts_dir)
content = read(test[1], String)

parser = CommonMark.Parser()

doc = CommonMark.parse(parser, IOBuffer(content))

html_body = CommonMark.html(doc)



for mdfile in glob("*.md", posts_dir)
    # Read markdown
    content = read(mdfile, String)
    # Convert to HTML
    doc = CommonMark.parse(parser, IOBuffer(content))

    html_body = CommonMark.html(doc)


    # Wrap with your site’s HTML template
    html_page = """
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Blog Post</title>
      <link rel="stylesheet" href="../../style.css">
    </head>
    <body>
      <a href="../index.html">← Back to Blog</a>
      <article>
        $html_body
      </article>
    </body>
    </html>
    """

    # Save as HTML (same filename, but .html)
    outfile = joinpath(output_dir, splitext(basename(mdfile))[1] * ".html")

    # Make sure the parent directory exists
    mkpath(dirname(outfile))

    open(outfile, "w") do f
        write(f, html_page)
    end
end