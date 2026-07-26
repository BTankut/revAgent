using System.Security.Cryptography;
using RevAgent.Contracts.Signing;

namespace RevAgent.Contracts.Tests.Signing;

public sealed class RsaXmlPublicKeyTests
{
    [Fact]
    public void ParsesExactPublicShapeAndNormalizesFingerprintWhitespace()
    {
        using var rsa = RSA.Create(2048);
        var xml = SignatureTestData.ToPublicXml(rsa);
        var withWhitespace = $"\r\n  {xml.Replace("><", ">\r\n  <")}\r\n";

        var parameters = RsaXmlPublicKey.Parse(withWhitespace);

        Assert.NotNull(parameters.Modulus);
        Assert.NotNull(parameters.Exponent);
        Assert.Equal(
            RsaXmlPublicKey.ComputeFingerprint(xml),
            RsaXmlPublicKey.ComputeFingerprint(withWhitespace));
    }

    [Theory]
    [InlineData("<RSAKeyValue extra=\"1\"><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>")]
    [InlineData("<RSAKeyValue><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent><D>AQ==</D></RSAKeyValue>")]
    [InlineData("<RSAKeyValue xmlns=\"urn:test\"><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>")]
    [InlineData("<RSAKeyValue><Modulus>not-base64</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>")]
    [InlineData("<?xml version=\"1.0\"?><RSAKeyValue><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>")]
    [InlineData("<!--comment--><RSAKeyValue><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>")]
    [InlineData("<RSAKeyValue><!--comment--><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>")]
    [InlineData("<RSAKeyValue><Modulus>AQ==<!--comment--></Modulus><Exponent>AQAB</Exponent></RSAKeyValue>")]
    [InlineData("<RSAKeyValue><Modulus><![CDATA[AQ==]]></Modulus><Exponent>AQAB</Exponent></RSAKeyValue>")]
    public void RejectsNonPublicOrMalformedXml(string xml)
    {
        Assert.Throws<InvalidDataException>(() => RsaXmlPublicKey.Parse(xml));
    }

    [Fact]
    public void RejectsDtds()
    {
        const string Xml =
            "<!DOCTYPE RSAKeyValue [<!ENTITY x \"AQ==\">]>"
            + "<RSAKeyValue><Modulus>&x;</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>";

        Assert.ThrowsAny<Exception>(() => RsaXmlPublicKey.Parse(Xml));
    }
}
